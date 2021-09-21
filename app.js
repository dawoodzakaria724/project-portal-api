const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const events = require('./user');

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.SQL_HOST,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    database: process.env.SQL_DATABASE,
    port: process.env.SQL_PORT
  });
  connection.config.namedPlaceholders = true;

  const ports = process.env.PORT || 3000;

  const app = express().use(cors()).use(express.json()).use(events(connection));

  app.listen(ports, () => console.log(`listening on port ${ports}`));
}

main();
