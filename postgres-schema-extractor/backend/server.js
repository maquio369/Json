// server.js - Versión mejorada
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

// Convertir nombre de columna a camelCase para propiedades
function toCamelCase(columnName) {
  return columnName.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

// Validar nombre de tabla/columna
function isValidIdentifier(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
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
  res.json({ message: 'API para extraer esquemas de PostgreSQL con relaciones e índices' });
});

// Endpoint para obtener todas las tablas en la base de datos
app.get('/api/tables', async (req, res) => {
  try {
    const client = await pool.connect();
    
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

// **NUEVA FUNCIONALIDAD: Obtener relaciones de una tabla**
app.get('/api/relationships/:tableName', async (req, res) => {
  try {
    const { tableName } = req.params;
    
    if (!isValidIdentifier(tableName)) {
      return res.status(400).json({ error: 'Nombre de tabla inválido' });
    }
    
    const client = await pool.connect();
    
    // Query para obtener Foreign Keys (relaciones salientes)
    const foreignKeysQuery = `
      SELECT 
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        rc.update_rule,
        rc.delete_rule
      FROM 
        information_schema.table_constraints AS tc 
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        JOIN information_schema.referential_constraints AS rc
          ON tc.constraint_name = rc.constraint_name
      WHERE 
        tc.constraint_type = 'FOREIGN KEY' 
        AND tc.table_name = $1
        AND tc.table_schema = 'public';
    `;
    
    // Query para obtener relaciones entrantes (tablas que referencian esta tabla)
    const incomingRelationsQuery = `
      SELECT 
        tc.table_name AS referencing_table,
        kcu.column_name AS referencing_column,
        ccu.column_name AS referenced_column,
        tc.constraint_name,
        rc.update_rule,
        rc.delete_rule
      FROM 
        information_schema.table_constraints AS tc 
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
        JOIN information_schema.referential_constraints AS rc
          ON tc.constraint_name = rc.constraint_name
      WHERE 
        tc.constraint_type = 'FOREIGN KEY' 
        AND ccu.table_name = $1
        AND tc.table_schema = 'public';
    `;
    
    const [foreignKeys, incomingRelations] = await Promise.all([
      client.query(foreignKeysQuery, [tableName]),
      client.query(incomingRelationsQuery, [tableName])
    ]);
    
    client.release();
    
    res.json({
      tableName,
      foreignKeys: foreignKeys.rows,
      incomingRelations: incomingRelations.rows
    });
    
  } catch (error) {
    console.error('Error al obtener relaciones:', error);
    res.status(500).json({ error: error.message });
  }
});

// **NUEVA FUNCIONALIDAD: Obtener índices de una tabla**
app.get('/api/indexes/:tableName', async (req, res) => {
  try {
    const { tableName } = req.params;
    
    if (!isValidIdentifier(tableName)) {
      return res.status(400).json({ error: 'Nombre de tabla inválido' });
    }
    
    const client = await pool.connect();
    
    // Query para obtener índices
    const indexesQuery = `
      SELECT 
        i.relname AS index_name,
        am.amname AS index_type,
        ix.indisunique AS is_unique,
        ix.indisprimary AS is_primary,
        ARRAY(
          SELECT a.attname
          FROM pg_attribute a
          WHERE a.attrelid = ix.indrelid
            AND a.attnum = ANY(ix.indkey)
          ORDER BY array_position(ix.indkey, a.attnum)
        ) AS columns,
        pg_get_indexdef(ix.indexrelid) AS index_definition
      FROM 
        pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_am am ON i.relam = am.oid
      WHERE 
        t.relname = $1
        AND t.relkind = 'r'
      ORDER BY 
        i.relname;
    `;
    
    const result = await client.query(indexesQuery, [tableName]);
    client.release();
    
    res.json({
      tableName,
      indexes: result.rows
    });
    
  } catch (error) {
    console.error('Error al obtener índices:', error);
    res.status(500).json({ error: error.message });
  }
});

// **NUEVA FUNCIONALIDAD: Obtener constraints complejos**
app.get('/api/constraints/:tableName', async (req, res) => {
  try {
    const { tableName } = req.params;
    
    if (!isValidIdentifier(tableName)) {
      return res.status(400).json({ error: 'Nombre de tabla inválido' });
    }
    
    const client = await pool.connect();
    
    // Query para obtener todos los constraints
    const constraintsQuery = `
      SELECT 
        tc.constraint_name,
        tc.constraint_type,
        ARRAY_AGG(kcu.column_name ORDER BY kcu.ordinal_position) AS columns,
        cc.check_clause,
        pg_get_constraintdef(pgc.oid) AS constraint_definition
      FROM 
        information_schema.table_constraints tc
        LEFT JOIN information_schema.key_column_usage kcu 
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        LEFT JOIN information_schema.check_constraints cc
          ON tc.constraint_name = cc.constraint_name
        LEFT JOIN pg_constraint pgc
          ON tc.constraint_name = pgc.conname
      WHERE 
        tc.table_name = $1
        AND tc.table_schema = 'public'
      GROUP BY 
        tc.constraint_name, tc.constraint_type, cc.check_clause, pgc.oid
      ORDER BY 
        tc.constraint_type, tc.constraint_name;
    `;
    
    const result = await client.query(constraintsQuery, [tableName]);
    client.release();
    
    res.json({
      tableName,
      constraints: result.rows
    });
    
  } catch (error) {
    console.error('Error al obtener constraints:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint mejorado para obtener el esquema detallado de tablas específicas
app.get('/api/schema', async (req, res) => {
  try {
    const tables = req.query.tables ? req.query.tables.split(',') : [];
    
    if (tables.length === 0) {
      return res.status(400).json({ error: 'Debe especificar al menos una tabla' });
    }
    
    // Validar nombres de tabla
    for (const tableName of tables) {
      if (!isValidIdentifier(tableName)) {
        return res.status(400).json({ error: `Nombre de tabla inválido: ${tableName}` });
      }
    }
    
    const client = await pool.connect();
    const schema = {};
    
    for (const tableName of tables) {
      // Obtener información básica de la tabla
      const tableCommentQuery = `
        SELECT obj_description(pgc.oid) as table_comment
        FROM pg_class pgc
        WHERE pgc.relname = $1;
      `;
      
      // Obtener columnas
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
      
      // Ejecutar queries en paralelo para mejor performance
      const [tableCommentResult, columnsResult] = await Promise.all([
        client.query(tableCommentQuery, [tableName]),
        client.query(columnsQuery, [tableName])
      ]);
      
      // Obtener relaciones, índices y constraints usando los nuevos endpoints internamente
      const [relationshipsResponse, indexesResponse, constraintsResponse] = await Promise.all([
        getRelationshipsInternal(client, tableName),
        getIndexesInternal(client, tableName),
        getConstraintsInternal(client, tableName)
      ]);
      
      schema[tableName] = {
        name: tableName,
        comment: tableCommentResult.rows[0]?.table_comment || '',
        columns: columnsResult.rows,
        relationships: relationshipsResponse,
        indexes: indexesResponse,
        constraints: constraintsResponse
      };
    }
    
    client.release();
    res.json(schema);
  } catch (error) {
    console.error('Error al obtener el esquema:', error);
    res.status(500).json({ error: error.message });
  }
});

// Funciones internas para reutilizar lógica
async function getRelationshipsInternal(client, tableName) {
  const foreignKeysQuery = `
    SELECT 
      tc.constraint_name,
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      rc.update_rule,
      rc.delete_rule
    FROM 
      information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON tc.constraint_name = rc.constraint_name
    WHERE 
      tc.constraint_type = 'FOREIGN KEY' 
      AND tc.table_name = $1
      AND tc.table_schema = 'public';
  `;
  
  const incomingRelationsQuery = `
    SELECT 
      tc.table_name AS referencing_table,
      kcu.column_name AS referencing_column,
      ccu.column_name AS referenced_column,
      tc.constraint_name,
      rc.update_rule,
      rc.delete_rule
    FROM 
      information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints AS rc
        ON tc.constraint_name = rc.constraint_name
    WHERE 
      tc.constraint_type = 'FOREIGN KEY' 
      AND ccu.table_name = $1
      AND tc.table_schema = 'public';
  `;
  
  const [foreignKeys, incomingRelations] = await Promise.all([
    client.query(foreignKeysQuery, [tableName]),
    client.query(incomingRelationsQuery, [tableName])
  ]);
  
  return {
    foreignKeys: foreignKeys.rows,
    incomingRelations: incomingRelations.rows
  };
}

async function getIndexesInternal(client, tableName) {
  const indexesQuery = `
    SELECT 
      i.relname AS index_name,
      am.amname AS index_type,
      ix.indisunique AS is_unique,
      ix.indisprimary AS is_primary,
      ARRAY(
        SELECT a.attname
        FROM pg_attribute a
        WHERE a.attrelid = ix.indrelid
          AND a.attnum = ANY(ix.indkey)
        ORDER BY array_position(ix.indkey, a.attnum)
      ) AS columns,
      pg_get_indexdef(ix.indexrelid) AS index_definition
    FROM 
      pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_am am ON i.relam = am.oid
    WHERE 
      t.relname = $1
      AND t.relkind = 'r'
    ORDER BY 
      i.relname;
  `;
  
  const result = await client.query(indexesQuery, [tableName]);
  return result.rows;
}

async function getConstraintsInternal(client, tableName) {
  const constraintsQuery = `
    SELECT 
      tc.constraint_name,
      tc.constraint_type,
      ARRAY_AGG(kcu.column_name ORDER BY kcu.ordinal_position) AS columns,
      cc.check_clause,
      pg_get_constraintdef(pgc.oid) AS constraint_definition
    FROM 
      information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu 
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      LEFT JOIN information_schema.check_constraints cc
        ON tc.constraint_name = cc.constraint_name
      LEFT JOIN pg_constraint pgc
        ON tc.constraint_name = pgc.conname
    WHERE 
      tc.table_name = $1
      AND tc.table_schema = 'public'
    GROUP BY 
      tc.constraint_name, tc.constraint_type, cc.check_clause, pgc.oid
    ORDER BY 
      tc.constraint_type, tc.constraint_name;
  `;
  
  const result = await client.query(constraintsQuery, [tableName]);
  return result.rows;
}

// **MEJORADO: Generador de entidades con relaciones, índices y validaciones**
app.get('/api/generate-entity/:tableName', async (req, res) => {
  try {
    const { tableName } = req.params;
    const includeRelations = req.query.relations === 'true';
    const includeIndexes = req.query.indexes === 'true';
    const includeValidations = req.query.validations === 'true';
    
    if (!isValidIdentifier(tableName)) {
      return res.status(400).json({ error: 'Nombre de tabla inválido' });
    }
    
    const client = await pool.connect();
    
    // Obtener toda la información necesaria
    const [tableCommentResult, columnsResult, relationships, indexes, constraints] = await Promise.all([
      client.query(`SELECT obj_description(pgc.oid) as table_comment FROM pg_class pgc WHERE pgc.relname = $1;`, [tableName]),
      client.query(`
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
      `, [tableName]),
      includeRelations ? getRelationshipsInternal(client, tableName) : null,
      includeIndexes ? getIndexesInternal(client, tableName) : null,
      includeValidations ? getConstraintsInternal(client, tableName) : null
    ]);
    
    client.release();
    
    // Generar el código TypeORM mejorado
    const entityCode = generateEnhancedEntity(
      tableName,
      tableCommentResult.rows[0]?.table_comment,
      columnsResult.rows,
      relationships,
      indexes,
      constraints,
      { includeRelations, includeIndexes, includeValidations }
    );
    
    // Establecer encabezados para descarga
    res.setHeader('Content-Type', 'application/typescript');
    res.setHeader('Content-Disposition', `attachment; filename=${tableName}.entity.ts`);
    
    res.send(entityCode);
    
  } catch (error) {
    console.error('Error al generar entidad:', error);
    res.status(500).json({ error: error.message });
  }
});

// **FUNCIÓN MEJORADA: Generar entidad TypeORM con todas las características**
function generateEnhancedEntity(tableName, tableComment, columns, relationships, indexes, constraints, options) {
  const className = toPascalCase(tableName);
  let imports = new Set(['Entity', 'Column', 'PrimaryGeneratedColumn']);
  let entityCode = '';
  
  // Agregar imports necesarios según las opciones
  if (options.includeRelations && relationships) {
    imports.add('ManyToOne');
    imports.add('OneToMany');
    imports.add('JoinColumn');
  }
  
  if (options.includeIndexes && indexes) {
    imports.add('Index');
  }
  
  if (options.includeValidations && constraints) {
    imports.add('Check');
    imports.add('Unique');
  }
  
  // Generar imports
  entityCode += `import { ${Array.from(imports).join(', ')} } from 'typeorm';\n`;
  
  // Agregar imports para validaciones si es necesario
  if (options.includeValidations) {
    entityCode += `import { IsNotEmpty, IsEmail, Length, IsNumber, IsDate } from 'class-validator';\n`;
  }
  
  entityCode += '\n';
  
  // Agregar comentario de tabla
  if (tableComment) {
    entityCode += `/**\n * ${tableComment}\n */\n`;
  }
  
  // Agregar índices a nivel de entidad
  if (options.includeIndexes && indexes) {
    const nonPrimaryIndexes = indexes.filter(idx => !idx.is_primary);
    nonPrimaryIndexes.forEach(index => {
      const columnsStr = index.columns.map(col => `"${col}"`).join(', ');
      const unique = index.is_unique ? ', { unique: true }' : '';
      entityCode += `@Index("${index.index_name}", [${columnsStr}]${unique})\n`;
    });
  }
  
  // Agregar constraints de verificación únicos a nivel de entidad
  if (options.includeValidations && constraints) {
    const uniqueConstraints = constraints.filter(c => c.constraint_type === 'UNIQUE' && c.columns.length > 1);
    uniqueConstraints.forEach(constraint => {
      const columnsStr = constraint.columns.map(col => `"${toCamelCase(col)}"`).join(', ');
      entityCode += `@Unique("${constraint.constraint_name}", [${columnsStr}])\n`;
    });
    
    const checkConstraints = constraints.filter(c => c.constraint_type === 'CHECK');
    checkConstraints.forEach(constraint => {
      if (constraint.check_clause) {
        entityCode += `@Check("${constraint.constraint_name}", "${constraint.check_clause}")\n`;
      }
    });
  }
  
  entityCode += `@Entity("${tableName}")\n`;
  entityCode += `export class ${className} {\n`;
  
  // Obtener claves primarias
  const primaryKeys = constraints ? 
    constraints.filter(c => c.constraint_type === 'PRIMARY KEY').flatMap(c => c.columns) : 
    [];
  
  // Procesar columnas
  columns.forEach(column => {
    const isPrimaryKey = primaryKeys.includes(column.column_name);
    const tsType = pgToTsTypeMap[column.data_type.toLowerCase()] || 'any';
    const propertyName = toCamelCase(column.column_name);
    
    // Agregar validaciones de class-validator
    if (options.includeValidations) {
      if (column.is_nullable === 'NO' && !isPrimaryKey) {
        entityCode += `  @IsNotEmpty()\n`;
      }
      
      // Validaciones específicas por tipo
      if (tsType === 'string') {
        if (column.character_maximum_length) {
          entityCode += `  @Length(1, ${column.character_maximum_length})\n`;
        }
        // Detectar emails por nombre de columna
        if (column.column_name.toLowerCase().includes('email')) {
          entityCode += `  @IsEmail()\n`;
        }
      } else if (tsType === 'number') {
        entityCode += `  @IsNumber()\n`;
      } else if (tsType === 'Date') {
        entityCode += `  @IsDate()\n`;
      }
    }
    
    // Generar decorador de columna
    if (isPrimaryKey) {
      if (column.column_default && column.column_default.includes('nextval')) {
        entityCode += `  @PrimaryGeneratedColumn()\n`;
      } else {
        entityCode += `  @PrimaryGeneratedColumn("uuid")\n`;
      }
    } else {
      // Construir opciones del decorador @Column
      let columnOptions = [];
      
      // Agregar tipo explícitamente para ciertos tipos
      if (column.data_type.toLowerCase().includes('timestamp')) {
        columnOptions.push(`type: 'timestamp'`);
      }
      
      if (column.is_nullable === 'NO') {
        columnOptions.push(`nullable: false`);
      }
      
      // Manejar valores por defecto
      if (column.column_default && !column.column_default.includes('nextval')) {
        let defaultValue = column.column_default;
        
        if (column.data_type.toLowerCase().includes('timestamp') && 
            (defaultValue.includes('CURRENT_TIMESTAMP') || defaultValue.includes('now()'))) {
          if (!columnOptions.some(opt => opt.startsWith('type:'))) {
            columnOptions.push(`type: 'timestamp'`);
          }
          columnOptions.push(`default: () => "CURRENT_TIMESTAMP"`);
        } else {
          if (tsType === 'string') {
            defaultValue = defaultValue.replace(/^'(.*)'$/, '$1');
            defaultValue = `'${defaultValue}'`;
          } else if (tsType === 'boolean') {
            defaultValue = defaultValue === "'t'" ? 'true' : 'false';
          }
          columnOptions.push(`default: ${defaultValue}`);
        }
      }
      
      if (column.column_comment) {
        columnOptions.push(`comment: '${column.column_comment.replace(/'/g, "\\'")}'`);
      }
      
      // Agregar constraint de unicidad si aplica
      if (options.includeValidations && constraints) {
        const uniqueConstraint = constraints.find(c => 
          c.constraint_type === 'UNIQUE' && 
          c.columns.length === 1 && 
          c.columns[0] === column.column_name
        );
        if (uniqueConstraint) {
          columnOptions.push(`unique: true`);
        }
      }
      
      if (columnOptions.length > 0) {
        entityCode += `  @Column({ ${columnOptions.join(', ')} })\n`;
      } else {
        entityCode += `  @Column()\n`;
      }
    }
    
    // Agregar la propiedad
    entityCode += `  ${propertyName}: ${tsType};\n\n`;
  });
  
  // Agregar relaciones si está habilitado
  if (options.includeRelations && relationships) {
    // Relaciones ManyToOne (Foreign Keys salientes)
    relationships.foreignKeys.forEach(fk => {
      const propertyName = toCamelCase(fk.foreign_table_name);
      const referencedClass = toPascalCase(fk.foreign_table_name);
      const joinColumnName = fk.column_name;
      
      entityCode += `  @ManyToOne(() => ${referencedClass}, ${propertyName.toLowerCase()} => ${propertyName.toLowerCase()}.${toCamelCase(tableName)}s)\n`;
      entityCode += `  @JoinColumn({ name: "${joinColumnName}" })\n`;
      entityCode += `  ${propertyName}: ${referencedClass};\n\n`;
    });
    
    // Relaciones OneToMany (Foreign Keys entrantes)
    const groupedIncoming = relationships.incomingRelations.reduce((acc, rel) => {
      if (!acc[rel.referencing_table]) {
        acc[rel.referencing_table] = [];
      }
      acc[rel.referencing_table].push(rel);
      return acc;
    }, {});
    
    Object.entries(groupedIncoming).forEach(([referencingTable, relations]) => {
      const propertyName = toCamelCase(referencingTable) + 's';
      const referencedClass = toPascalCase(referencingTable);
      const inverseSide = toCamelCase(tableName);
      
      entityCode += `  @OneToMany(() => ${referencedClass}, ${referencingTable.toLowerCase()} => ${referencingTable.toLowerCase()}.${inverseSide})\n`;
      entityCode += `  ${propertyName}: ${referencedClass}[];\n\n`;
    });
  }
  
  entityCode += `}\n`;
  
  return entityCode;
}

// **MEJORADO: Endpoint para generar todas las entidades con opciones**
app.get('/api/generate-all-entities', async (req, res) => {
  try {
    const includeRelations = req.query.relations === 'true';
    const includeIndexes = req.query.indexes === 'true';
    const includeValidations = req.query.validations === 'true';
    
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
    res.setHeader('Content-Disposition', 'attachment; filename=typeorm-entities-enhanced.zip');
    
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });
    
    archive.pipe(res);
    
    // Para cada tabla, generar su entidad mejorada
    for (const tableRow of tablesResult.rows) {
      const tableName = tableRow.table_name;
      
      try {
        // Obtener toda la información necesaria
        const [tableCommentResult, columnsResult, relationships, indexes, constraints] = await Promise.all([
          client.query(`SELECT obj_description(pgc.oid) as table_comment FROM pg_class pgc WHERE pgc.relname = $1;`, [tableName]),
          client.query(`
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
          `, [tableName]),
          includeRelations ? getRelationshipsInternal(client, tableName) : null,
          includeIndexes ? getIndexesInternal(client, tableName) : null,
          includeValidations ? getConstraintsInternal(client, tableName) : null
        ]);
        
        // Generar el código de la entidad
        const entityCode = generateEnhancedEntity(
          tableName,
          tableCommentResult.rows[0]?.table_comment,
          columnsResult.rows,
          relationships,
          indexes,
          constraints,
          { includeRelations, includeIndexes, includeValidations }
        );
        
        // Agregar la entidad al ZIP
        archive.append(entityCode, { name: `${tableName}.entity.ts` });
        
      } catch (error) {
        console.error(`Error procesando tabla ${tableName}:`, error);
        // Continuar con las demás tablas
      }
    }
    
    client.release();
    
    // Agregar archivo README con información sobre las opciones utilizadas
    const readmeContent = `# Entidades TypeORM Generadas

## Opciones utilizadas:
- Relaciones: ${includeRelations ? 'Sí' : 'No'}
- Índices: ${includeIndexes ? 'Sí' : 'No'}
- Validaciones: ${includeValidations ? 'Sí' : 'No'}

## Instalación de dependencias necesarias:

\`\`\`bash
npm install typeorm reflect-metadata
${includeValidations ? 'npm install class-validator class-transformer' : ''}
\`\`\`

## Uso:

1. Importa las entidades en tu aplicación
2. Configura TypeORM con estas entidades
3. ${includeValidations ? 'Habilita class-validator en tu aplicación' : 'Las entidades están listas para usar'}

## Características incluidas:

- **Mapeo completo de tipos PostgreSQL a TypeScript**
- **Decoradores TypeORM apropiados**
- **Comentarios de tabla y columnas preservados**
${includeRelations ? '- **Relaciones ManyToOne y OneToMany**' : ''}
${includeIndexes ? '- **Índices de base de datos**' : ''}
${includeValidations ? '- **Validaciones con class-validator**' : ''}
${includeValidations ? '- **Constraints de unicidad y verificación**' : ''}

Generado el: ${new Date().toISOString()}
`;
    
    archive.append(readmeContent, { name: 'README.md' });
    
    // Finalizar el archivo ZIP
    archive.finalize();
    
  } catch (error) {
    console.error('Error al generar todas las entidades:', error);
    res.status(500).json({ error: error.message });
  }
});

// **NUEVO: Endpoint para validar esquema de entidad**
app.post('/api/validate-entity', async (req, res) => {
  try {
    const { tableName, entityCode } = req.body;
    
    if (!tableName || !entityCode) {
      return res.status(400).json({ error: 'tableName y entityCode son requeridos' });
    }
    
    if (!isValidIdentifier(tableName)) {
      return res.status(400).json({ error: 'Nombre de tabla inválido' });
    }
    
    // Validaciones básicas del código de entidad
    const validations = [];
    
    // Verificar que tenga los imports necesarios
    if (!entityCode.includes('import') || !entityCode.includes('typeorm')) {
      validations.push({
        type: 'error',
        message: 'Faltan imports de TypeORM'
      });
    }
    
    // Verificar que tenga el decorador @Entity
    if (!entityCode.includes('@Entity')) {
      validations.push({
        type: 'error',
        message: 'Falta el decorador @Entity'
      });
    }
    
    // Verificar que tenga al menos una columna
    if (!entityCode.includes('@Column') && !entityCode.includes('@PrimaryGeneratedColumn')) {
      validations.push({
        type: 'error',
        message: 'La entidad debe tener al menos una columna'
      });
    }
    
    // Verificar sintaxis básica de TypeScript
    const syntaxErrors = [];
    
    // Verificar llaves balanceadas
    const openBraces = (entityCode.match(/{/g) || []).length;
    const closeBraces = (entityCode.match(/}/g) || []).length;
    
    if (openBraces !== closeBraces) {
      syntaxErrors.push('Llaves no balanceadas');
    }
    
    // Verificar paréntesis balanceados
    const openParens = (entityCode.match(/\(/g) || []).length;
    const closeParens = (entityCode.match(/\)/g) || []).length;
    
    if (openParens !== closeParens) {
      syntaxErrors.push('Paréntesis no balanceados');
    }
    
    if (syntaxErrors.length > 0) {
      validations.push({
        type: 'error',
        message: `Errores de sintaxis: ${syntaxErrors.join(', ')}`
      });
    }
    
    // Advertencias
    if (!entityCode.includes('export class')) {
      validations.push({
        type: 'warning',
        message: 'Se recomienda exportar la clase de entidad'
      });
    }
    
    if (entityCode.includes('@Column()') && !entityCode.includes('nullable')) {
      validations.push({
        type: 'info',
        message: 'Considera especificar explícitamente nullable: false para columnas requeridas'
      });
    }
    
    const hasErrors = validations.some(v => v.type === 'error');
    
    res.json({
      isValid: !hasErrors,
      validations,
      suggestions: [
        'Asegúrate de instalar las dependencias: npm install typeorm reflect-metadata',
        'Para validaciones: npm install class-validator class-transformer',
        'Registra las entidades en tu configuración de TypeORM'
      ]
    });
    
  } catch (error) {
    console.error('Error al validar entidad:', error);
    res.status(500).json({ error: error.message });
  }
});

// Inicializar el servidor
app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
  console.log(`📊 API mejorada con soporte para:`);
  console.log(`   - Relaciones entre tablas (ManyToOne, OneToMany)`);
  console.log(`   - Índices y constraints complejos`);
  console.log(`   - Validaciones con class-validator`);
  console.log(`   - Validación de código generado`);
});