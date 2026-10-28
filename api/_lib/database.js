import { neon } from '@neondatabase/serverless';

let database;
let databaseUrl;

export function getDatabase() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl) throw new Error('DATABASE_URL is not configured.');

  // Neon sometimes displays JDBC URLs. The serverless driver needs a regular
  // Postgres URL, so translate JDBC query credentials into URL credentials.
  let connectionString = configuredUrl.trim();
  if (connectionString.startsWith('jdbc:')) {
    const url = new URL(connectionString.slice('jdbc:'.length));
    const username = url.searchParams.get('user');
    const password = url.searchParams.get('password');
    if (!url.username && username) url.username = username;
    if (!url.password && password) url.password = password;
    url.searchParams.delete('user');
    url.searchParams.delete('password');
    connectionString = url.toString();
  }

  if (!database || databaseUrl !== connectionString) {
    databaseUrl = connectionString;
    database = neon(connectionString);
  }
  return database;
}
