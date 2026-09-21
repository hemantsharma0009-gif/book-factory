/**
 * Durable state. A single JSON manifest plus a directory per book keeps the
 * engine dependency-free and makes every artifact inspectable by hand.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./config.js";

const EMPTY = { version: 1, books: [], genreHistory: [], schedule: null, runs: [] };

export async function ensureDirs() {
  await fs.mkdir(paths().books, { recursive: true });
}

export async function load() {
  try {
    const raw = await fs.readFile(paths().manifest, "utf8");
    const parsed = JSON.parse(raw);
    return { ...EMPTY, ...parsed };
  } catch (err) {
    if (err.code === "ENOENT") return { ...EMPTY };
    throw new Error(`library.json is unreadable (${err.message}). Move it aside to start fresh.`);
  }
}

export async function save(state) {
  await ensureDirs();
  const tmp = `${paths().manifest}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, paths().manifest); // atomic: never leave a half-written manifest
}

export async function update(mutator) {
  const state = await load();
  const result = await mutator(state);
  await save(state);
  return result;
}

export function bookDir(id) {
  return path.join(paths().books, id);
}

export async function writeArtifact(id, name, contents) {
  const dir = bookDir(id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  return file;
}

export async function readArtifact(id, name) {
  return fs.readFile(path.join(bookDir(id), name));
}

export function findBook(state, id) {
  return state.books.find((b) => b.id === id) || null;
}
