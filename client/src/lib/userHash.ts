const USER_HASH_STORAGE_KEY = "vir-space-user-hash";

/**
 * Generate a random hash for user identification
 * This hash persists across sessions and is used to prevent banned users from rejoining
 */
function generateRandomHash(): string {
  // Generate a random hash using crypto API
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Get or create the user hash
 * If a hash doesn't exist, a new one is generated and stored
 */
export function getUserHash(): string {
  const stored = sessionStorage.getItem(USER_HASH_STORAGE_KEY);
  if (stored) {
    return stored;
  }

  const hash = generateRandomHash();
  sessionStorage.setItem(USER_HASH_STORAGE_KEY, hash);
  return hash;
}

/**
 * Clear the user hash (called when user logs out or clears data)
 */
export function clearUserHash(): void {
  sessionStorage.removeItem(USER_HASH_STORAGE_KEY);
}
