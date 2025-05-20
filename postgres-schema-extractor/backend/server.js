// server.js
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(cors({
    origin: '*', // Durante desarrollo, permitir todas las solicitudes
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Servir archivos estáticos desde la carpeta public
app.use(express.static('public'));

// Configuración de la conexión a PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

// Mapeo de tipos de PostgreSQL a TypeScript
const pgToTsTypeMap = {
  'integer': 'number',
  'bigint': 'number',
  'smallint': 'number',
  'decimal': 'number',
  'numeric': 'number',
  'real': 'number',
  'double precision': 'number',
  'character varying': 'string',
  'varchar': 'string',
  'character': 'string',
  'char': 'string',
  'text': 'string',
  'boolean': 'boolean',
  'date': 'Date',
  'timestamp': 'Date',
  'timestamp with time zone': 'Date',
  'timestamp without time zone': 'Date',
  'time': 'string',
  'time with time zone': 'string',
  'time without time zone': 'string',
  'interval': 'string',
  'json': 'any',
  'jsonb': 'any',
  'uuid': 'string',
  'bytea': 'Buffer',
  'array': 'any[]',
};

// Convertir nombre de tabla a formato PascalCase para nombre de clase
function toPascalCase(tableName) {
  return tableName
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

// Ruta para probar la conexión
app.get('/api/test', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    res.json({ success: true, time: result.rows[0].now });
  } catch (error) {
    console.error('Error al conectar a la base de datos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ruta raíz
app.get('/', (req, res) => {
  res.json({ message: 'API para extraer esquemas de PostgreSQL' });
});

// Endpoint para obtener todas las tablas en la base de datos
app.get('/api/tables', async (req, res) => {
  try {
    const client = await pool.connect();
    
    // Consulta para obtener todas las tablas del esquema public
    const tablesQuery = `
      SELECT 
        t.table_name,
        obj_description(pgc.oid) as table_comment
      FROM 
        information_schema.tables t
      JOIN 
        pg_class pgc ON pgc.relname = t.table_name
      WHERE 
        t.table_schema = 'public' 
        AND t.table_type = 'BASE TABLE'
      ORDER BY 
        t.table_name;
    `;
    
    const result = await client.query(tablesQuery);
    client.release();
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener las tablas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para obtener el esquema detallado de tablas específicas
app.get('/api/schema', async (req, res) => {
  try {
    // Obtener tablas de la consulta (separadas por comas)
    const tables = req.query.tables ? req.query.tables.split(',') : [];
    
    if (tables.length === 0) {
      return res.status(400).json({ error: 'Debe especificar al menos una tabla' });
    }
    
    const client = await pool.connect();
    const schema = {};
    
    // Para cada tabla solicitada
    for (const tableName of tables) {
      // Validar nombre de tabla para prevenir inyección SQL
      if (!tableName.match(/^[a-zA-Z0-9_]+$/)) {
        continue; // Saltamos tablas con nombres inválidos
      }
      
      // Consulta para obtener comentario de la tabla
      const tableCommentQuery = `
        SELECT obj_description(pgc.oid) as table_comment
        FROM pg_class pgc
        WHERE pgc.relname = $1;
      `;
      const tableCommentResult = await client.query(tableCommentQuery, [tableName]);
      
      // Consulta para obtener columnas y sus comentarios
      const columnsQuery = `
        SELECT 
          c.column_name, 
          c.data_type, 
          c.character_maximum_length,
          c.is_nullable,
          c.column_default,
          pgd.description as column_comment
        FROM 
          information_schema.columns c
        LEFT JOIN 
          pg_catalog.pg_statio_all_tables st ON st.relname = c.table_name
        LEFT JOIN 
          pg_catalog.pg_description pgd ON pgd.objoid = st.relid 
          AND pgd.objsubid = c.ordinal_position
        WHERE 
          c.table_schema = 'public' 
          AND c.table_name = $1
        ORDER BY 
          c.ordinal_position;
      `;
      
      const columnsResult = await client.query(columnsQuery, [tableName]);
      
      // Consulta para obtener restricciones (claves primarias, etc.)
      const constraintsQuery = `
        SELECT 
          c.constraint_name,
          c.constraint_type,
          kcu.column_name
        FROM 
          information_schema.table_constraints c
        JOIN 
          information_schema.key_column_usage kcu 
          ON c.constraint_name = kcu.constraint_name 
          AND c.table_name = kcu.table_name
        WHERE 
          c.table_schema = 'public' 
          AND c.table_name = $1
        ORDER BY 
          c.constraint_name, kcu.column_name;
      `;
      
      const constraintsResult = await client.query(constraintsQuery, [tableName]);
      
      // Agrupar restricciones por tipo
      const constraints = {};
      constraintsResult.rows.forEach(row => {
        if (!constraints[row.constraint_type]) {
          constraints[row.constraint_type] = [];
        }
        constraints[row.constraint_type].push({
          name: row.constraint_name,
          column: row.column_name
        });
      });
      
      // Construir objeto de esquema para esta tabla
      schema[tableName] = {
        name: tableName,
        comment: tableCommentResult.rows[0]?.table_comment || '',
        columns: columnsResult.rows,
        constraints: constraints
      };
    }
    
    client.release();
    res.json(schema);
  } catch (error) {
    console.error('Error al obtener el esquema:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para generar archivo de entidad TypeORM
app.get('/api/generate-entity/:tableName', async (req, res) => {
  try {
    const { tableName } = req.params;
    
    // Validar nombre de tabla para prevenir inyección SQL
    if (!tableName.match(/^[a-zA-Z0-9_]+$/)) {
      return res.status(400).json({ error: 'Nombre de tabla inválido' });
    }
    
    const client = await pool.connect();
    
    // Obtener esquema de la tabla
    const schemaQuery = `
      SELECT 
        c.column_name, 
        c.data_type, 
        c.character_maximum_length,
        c.is_nullable,
        c.column_default,
        pgd.description as column_comment
      FROM 
        information_schema.columns c
      LEFT JOIN 
        pg_catalog.pg_statio_all_tables st ON st.relname = c.table_name
      LEFT JOIN 
        pg_catalog.pg_description pgd ON pgd.objoid = st.relid 
        AND pgd.objsubid = c.ordinal_position
      WHERE 
        c.table_schema = 'public' 
        AND c.table_name = $1
      ORDER BY 
        c.ordinal_position;
    `;
    
    const columnsResult = await client.query(schemaQuery, [tableName]);
    
    // Obtener comentario de la tabla
    const tableCommentQuery = `
      SELECT obj_description(pgc.oid) as table_comment
      FROM pg_class pgc
      WHERE pgc.relname = $1;
    `;
    const tableCommentResult = await client.query(tableCommentQuery, [tableName]);
    
    // Obtener clave primaria
    const pkQuery = `
      SELECT 
        c.column_name
      FROM 
        information_schema.table_constraints tc
      JOIN 
        information_schema.constraint_column_usage ccu 
        ON tc.constraint_name = ccu.constraint_name
      JOIN 
        information_schema.columns c 
        ON c.table_name = tc.table_name AND c.column_name = ccu.column_name
      WHERE 
        tc.constraint_type = 'PRIMARY KEY' 
        AND tc.table_name = $1;
    `;
    
    const pkResult = await client.query(pkQuery, [tableName]);
    
    client.release();
    
    // Generar el código TypeORM
    let entityCode = `import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';\n\n`;
    
    // Añadir comentario de tabla si existe
    if (tableCommentResult.rows[0]?.table_comment) {
      entityCode += `/**\n * ${tableCommentResult.rows[0].table_comment}\n */\n`;
    }
    
    entityCode += `@Entity()\nexport class ${toPascalCase(tableName)} {\n`;
    
    // Procesar columnas
    for (const column of columnsResult.rows) {
      // Determinar si es clave primaria
      const isPrimaryKey = pkResult.rows.some(pk => pk.column_name === column.column_name);
      
      // Obtener tipo TypeScript para el tipo PostgreSQL
      const tsType = pgToTsTypeMap[column.data_type.toLowerCase()] || 'any';
      
      // Generar decorador de columna
      if (isPrimaryKey) {
        entityCode += `  @PrimaryGeneratedColumn()\n`;
      } else {
        // Construir opciones del decorador @Column
        let columnOptions = [];
        
        if (column.is_nullable === 'NO') {
          columnOptions.push(`nullable: false`);
        }


        if (column.column_default && !column.column_default.includes('nextval')) {
  let defaultValue = column.column_default;
  
  // Manejar específicamente los timestamps por defecto
  if (column.data_type.toLowerCase().includes('timestamp') && 
      (defaultValue.includes('CURRENT_TIMESTAMP') || defaultValue.includes('now()'))) {
    columnOptions.push(`type: 'timestamp'`);
    columnOptions.push(`default: () => "CURRENT_TIMESTAMP"`);
  } else {
    // Formatear el valor predeterminado según el tipo
    if (tsType === 'string') {
      // Limpiar comillas simples que vienen de PostgreSQL
      defaultValue = defaultValue.replace(/^'(.*)'$/, '$1');
      defaultValue = `'${defaultValue}'`; // Agregar comillas para string
    } else if (tsType === 'boolean') {
      // Convertir 't'/'f' a true/false
      defaultValue = defaultValue === "'t'" ? 'true' : 'false';
    }
    
    columnOptions.push(`default: ${defaultValue}`);
  }
}
        

        
        if (column.column_comment) {
          columnOptions.push(`comment: '${column.column_comment.replace(/'/g, "\\'")}'`);
        }
        
        if (columnOptions.length > 0) {
          entityCode += `  @Column({ ${columnOptions.join(', ')} })\n`;
        } else {
          entityCode += `  @Column()\n`;
        }
      }
      
      // Agregar la propiedad
      entityCode += `  ${column.column_name}: ${tsType};\n\n`;
    }
    
    entityCode += `}\n`;
    
    // Establecer encabezados para descarga de archivo
    res.setHeader('Content-Type', 'application/typescript');
    res.setHeader('Content-Disposition', `attachment; filename=${tableName}.entity.ts`);
    
    // Enviar el código generado
    res.send(entityCode);
    
  } catch (error) {
    console.error('Error al generar entidad:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para generar todas las entidades TypeORM
app.get('/api/generate-all-entities', async (req, res) => {
  try {
    const client = await pool.connect();
    
    // Obtener todas las tablas
    const tablesQuery = `
      SELECT 
        t.table_name
      FROM 
        information_schema.tables t
      WHERE 
        t.table_schema = 'public' 
        AND t.table_type = 'BASE TABLE'
      ORDER BY 
        t.table_name;
    `;
    
    const tablesResult = await client.query(tablesQuery);
    
    if (tablesResult.rows.length === 0) {
      return res.status(404).json({ error: 'No se encontraron tablas' });
    }
    
    // Crear un archivo ZIP con todas las entidades
    const archiver = require('archiver');
    
    // Configurar la respuesta como un archivo ZIP descargable
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=typeorm-entities.zip');
    
    const archive = archiver('zip', {
      zlib: { level: 9 } // Nivel de compresión máximo
    });
    
    // Conectar el archivo a la respuesta
    archive.pipe(res);
    
    // Para cada tabla, generar su entidad y agregarla al ZIP
    for (const tableRow of tablesResult.rows) {
      const tableName = tableRow.table_name;
      
      // Obtener esquema de la tabla
      const schemaQuery = `
        SELECT 
          c.column_name, 
          c.data_type, 
          c.character_maximum_length,
          c.is_nullable,
          c.column_default,
          pgd.description as column_comment
        FROM 
          information_schema.columns c
        LEFT JOIN 
          pg_catalog.pg_statio_all_tables st ON st.relname = c.table_name
        LEFT JOIN 
          pg_catalog.pg_description pgd ON pgd.objoid = st.relid 
          AND pgd.objsubid = c.ordinal_position
        WHERE 
          c.table_schema = 'public' 
          AND c.table_name = $1
        ORDER BY 
          c.ordinal_position;
      `;
      
      const columnsResult = await client.query(schemaQuery, [tableName]);
      
      // Obtener comentario de la tabla
      const tableCommentQuery = `
        SELECT obj_description(pgc.oid) as table_comment
        FROM pg_class pgc
        WHERE pgc.relname = $1;
      `;
      const tableCommentResult = await client.query(tableCommentQuery, [tableName]);
      
      // Obtener clave primaria
      const pkQuery = `
        SELECT 
          c.column_name
        FROM 
          information_schema.table_constraints tc
        JOIN 
          information_schema.constraint_column_usage ccu 
          ON tc.constraint_name = ccu.constraint_name
        JOIN 
          information_schema.columns c 
          ON c.table_name = tc.table_name AND c.column_name = ccu.column_name
        WHERE 
          tc.constraint_type = 'PRIMARY KEY' 
          AND tc.table_name = $1;
      `;
      
      const pkResult = await client.query(pkQuery, [tableName]);
      
      // Generar el código TypeORM
      let entityCode = `import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';\n\n`;
      
      // Añadir comentario de tabla si existe
      if (tableCommentResult.rows[0]?.table_comment) {
        entityCode += `/**\n * ${tableCommentResult.rows[0].table_comment}\n */\n`;
      }
      
        // ...dentro del ciclo for (const column of columnsResult.rows) { ... } en la generación de entidades...
      
      // Generar decorador de columna
      if (isPrimaryKey) {
        entityCode += `  @PrimaryGeneratedColumn()\n`;
      } else {
        // Construir opciones del decorador @Column
        let columnOptions = [];
      
        // Agregar tipo explícitamente para timestamps
        if (column.data_type.toLowerCase().includes('timestamp')) {
          columnOptions.push(`type: 'timestamp'`);
        }
      
        if (column.is_nullable === 'NO') {
          columnOptions.push(`nullable: false`);
        }
      
        if (column.column_default && !column.column_default.includes('nextval')) {
          let defaultValue = column.column_default;
      
          // Manejar específicamente los timestamps por defecto
          if (
            column.data_type.toLowerCase().includes('timestamp') &&
            (defaultValue.includes('CURRENT_TIMESTAMP') || defaultValue.includes('now()'))
          ) {
            if (!columnOptions.some(opt => opt.startsWith('type:'))) {
              columnOptions.push(`type: 'timestamp'`);
            }
            columnOptions.push(`default: () => "CURRENT_TIMESTAMP"`);
          } else {
            // Formatear el valor predeterminado según el tipo
            if (tsType === 'string') {
              // Limpiar comillas simples que vienen de PostgreSQL
              defaultValue = defaultValue.replace(/^'(.*)'$/, '$1');
              defaultValue = `'${defaultValue}'`; // Agregar comillas para string
            } else if (tsType === 'boolean') {
              // Convertir 't'/'f' a true/false
              defaultValue = defaultValue === "'t'" ? 'true' : 'false';
            }
      
            columnOptions.push(`default: ${defaultValue}`);
          }
        }
      
        if (column.column_comment) {
          columnOptions.push(`comment: '${column.column_comment.replace(/'/g, "\\'")}'`);
        }
      
        if (columnOptions.length > 0) {
          entityCode += `  @Column({ ${columnOptions.join(', ')} })\n`;
        } else {
          entityCode += `  @Column()\n`;
        }
      }
      
      // ...resto del ciclo...    entityCode += `@Entity()\nexport class ${toPascalCase(tableName)} {\n`;
      
      // Procesar columnas
      for (const column of columnsResult.rows) {
        // Determinar si es clave primaria
        const isPrimaryKey = pkResult.rows.some(pk => pk.column_name === column.column_name);
        
        // Obtener tipo TypeScript para el tipo PostgreSQL
        const tsType = pgToTsTypeMap[column.data_type.toLowerCase()] || 'any';
        
        // Generar decorador de columna
        if (isPrimaryKey) {
          entityCode += `  @PrimaryGeneratedColumn()\n`;
        } else {
          // Construir opciones del decorador @Column
          let columnOptions = [];
          
          if (column.is_nullable === 'NO') {
            columnOptions.push(`nullable: false`);
          }
          
          if (column.column_default && !column.column_default.includes('nextval')) {
            let defaultValue = column.column_default;
            
            // Formatear el valor predeterminado según el tipo
            if (tsType === 'string') {
              // Limpiar comillas simples que vienen de PostgreSQL
              defaultValue = defaultValue.replace(/^'(.*)'$/, '$1');
              defaultValue = `'${defaultValue}'`; // Agregar comillas para string
            } else if (tsType === 'boolean') {
              // Convertir 't'/'f' a true/false
              defaultValue = defaultValue === "'t'" ? 'true' : 'false';
            }
            
            columnOptions.push(`default: ${defaultValue}`);
          }
          
          if (column.column_comment) {
            columnOptions.push(`comment: '${column.column_comment.replace(/'/g, "\\'")}'`);
          }
          
          if (columnOptions.length > 0) {
            entityCode += `  @Column({ ${columnOptions.join(', ')} })\n`;
          } else {
            entityCode += `  @Column()\n`;
          }
        }
        
        // Agregar la propiedad
        entityCode += `  ${column.column_name}: ${tsType};\n\n`;
      }
      
      entityCode += `}\n`;
      
      // Agregar la entidad generada al archivo ZIP
      archive.append(entityCode, { name: `${tableName}.entity.ts` });
    }
    
    client.release();
    
    // Finalizar el archivo ZIP
    archive.finalize();
    
  } catch (error) {
    console.error('Error al generar todas las entidades:', error);
    res.status(500).json({ error: error.message });
  }
});


// Iniciar el servidor
app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});