//
// FLST Chrome <<>> Focus Last Selected Tab <<>> Rev 3.0.3
//
// FLST provides natural / MRU tab ordering, plus Options for
// Tab-Flipping, New-Tab-Select, and New-Tab-Location.
// Some features are related to (former) FireFox versions.
//
// Refactored for better maintainability and separation of concerns.
//

import { extensionCore } from "./core/extension-core.js";
import { logger } from "./utils/logger.js";

// Initialize the extension
extensionCore.initialize().catch((error) => {
  logger.error("Failed to initialize FLST Chrome extension", error);
  console.error("Critical error during extension initialization:", error);
});

// Export for debugging purposes
(globalThis as any).FLST_DEBUG = {
  getStatus: () => extensionCore.getStatus(),
  shutdown: () => extensionCore.shutdown(),
  reinitialize: () => extensionCore.initialize(),
};
