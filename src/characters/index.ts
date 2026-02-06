import { type Character } from "@elizaos/core";
import { pamela } from "./pamela";

/**
 * Character Registry
 */

export const characters: Record<string, Character> = {
  pamela,
};

export function getCharacter(name: string): Character | null {
  const normalizedName = name.toLowerCase().trim();
  return characters[normalizedName] || null;
}

export function getCharacterById(id: string): Character | null {
  return Object.values(characters).find((char) => char.id === id) || null;
}

export function listCharacters(): string[] {
  return Object.keys(characters);
}

export function hasCharacter(name: string): boolean {
  return getCharacter(name) !== null;
}

export { pamela };

export default characters;
