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

// Configuración de la conexión a PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

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

// Iniciar el servidor
app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});