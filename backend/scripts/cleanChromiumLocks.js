const fs = require('fs');
const path = require('path');

const LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

function cleanLocksInDirectory(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }

  let cleaned = 0;
  const items = fs.readdirSync(dir);

  for (const item of items) {
    const itemPath = path.join(dir, item);
    const stat = fs.statSync(itemPath);

    if (stat.isDirectory()) {
      // Recursively clean subdirectories
      cleaned += cleanLocksInDirectory(itemPath);
    } else if (LOCK_FILES.includes(item)) {
      // Remove lock file
      try {
        fs.unlinkSync(itemPath);
        console.log(`[lock-cleanup] Removed: ${itemPath}`);
        cleaned += 1;
      } catch (error) {
        console.error(`[lock-cleanup] Failed to remove ${itemPath}:`, error.message);
      }
    }
  }

  return cleaned;
}

function main() {
  console.log('[lock-cleanup] Starting Chromium lock file cleanup...');

  const authDir = path.join(__dirname, '..', '.wwebjs_auth');
  const cacheDir = path.join(__dirname, '..', '.wwebjs_cache');
  
  const authCleaned = cleanLocksInDirectory(authDir);
  const cacheCleaned = cleanLocksInDirectory(cacheDir);
  const totalCleaned = authCleaned + cacheCleaned;

  console.log(`[lock-cleanup] Cleanup complete. Removed ${totalCleaned} lock file(s).`);
}

main();
