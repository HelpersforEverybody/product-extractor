import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Returns an absolute path to /app/public/debug and ensures it exists
export function getDebugDir() {
  const dir = path.join(__dirname, "..", "public", "debug");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Builds the public URL (served by express.static)
export function toDebugUrl(filename) {
  return `/debug/${filename}`;
}
