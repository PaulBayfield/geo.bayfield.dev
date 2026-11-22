// Server configuration, read once from the environment (see server/.env.example).

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name} (see server/.env.example)`);
  return value;
}

export const DATABASE_URL = required("DATABASE_URL");
export const PORT = Number(process.env.PORT ?? 8840);
