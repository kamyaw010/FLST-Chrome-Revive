# FLST Chrome Revive

**Focus Last Selected Tab :: Provides natural / MRU tab ordering + Options for Tab Flipping, New Tab Select, and New Tab Location**

[![Version](https://img.shields.io/badge/version-3.1.0-blue.svg)](https://github.com/kamyaw010/FLST-Chrome-Revive)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Extension-green.svg)](https://chromewebstore.google.com/detail/flst-chrome-revive/alipmjpidmffnmkccdacnlfllkeogapb)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange.svg)](https://developer.chrome.com/docs/extensions/mv3/)

## 🚀 Overview

FLST Chrome Revive is a modern Chrome extension that implements Most Recently Used (MRU) tab ordering to provide natural tab navigation behavior. When you close a tab or use the tab flipping feature, the extension intelligently selects the most recently used tab instead of Chrome's default behavior of selecting the adjacent tab.

### ✨ Key Features

- **🔄 Smart Tab Flipping**: Navigate between your most recently used tabs with `Alt+N`
- **📍 MRU Tab Ordering**: Natural tab selection when closing tabs
- **🆕 New Tab Control**: Choose where new tabs open and whether they become active
- **🔧 Configurable Options**: Customize behavior through an intuitive options page
- **⚡ High Performance**: Optimized with modern service worker architecture
- **🛡️ Minimal Permissions**: Only requests essential storage permission
- **📱 Modern Design**: Clean, responsive options interface

## 🛠️ Installation

### From Chrome Web Store (Recommended)

1. Visit the [Chrome Web Store page](https://chromewebstore.google.com/detail/flst-chrome-revive/alipmjpidmffnmkccdacnlfllkeogapb)
2. Click "Add to Chrome"
3. Confirm the installation

### Manual Installation (Development)

1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm run build:prod` to build the extension
4. Open Chrome and navigate to `chrome://extensions/`
5. Enable "Developer mode"
6. Click "Load unpacked" and select the `dist` folder

## 🎯 How It Works

### Tab Flipping

- Press `Alt+N` (or click the extension icon) to switch between your two most recently used tabs
- Perfect for quick back-and-forth navigation between related tabs

### Smart Tab Closing

When you close a tab:

- **With Tab Flipping ON**: Automatically selects your most recently used tab
- **With Tab Flipping OFF**: Uses Chrome's default behavior (adjacent tab)

### New Tab Behavior

Configure what happens when you create a new tab:

- **Auto-select new tabs**: Choose whether new tabs become active immediately
- **Tab placement**: Control where new tabs appear in your tab bar

## ⚙️ Configuration

Access the options page by:

1. Right-clicking the extension icon → "Options"
2. Or visiting `chrome://extensions/` → FLST Chrome Revive → "Details" → "Extension options"

### Available Settings

| Setting              | Description                          | Default |
| -------------------- | ------------------------------------ | ------- |
| **Tab Flipping**     | Enable/disable Alt+N tab switching   | On      |
| **New Tab Select**   | Auto-activate newly created tabs     | Off     |
| **New Tab Location** | Where new tabs appear in the tab bar | End     |

## 🏗️ Technical Architecture

### Modern Manifest V3 Design

- **Service Worker**: Efficient background processing with automatic lifecycle management
- **Message-Based Reactivation**: Real-time service worker state detection (5-second intervals)
- **Persistent Storage**: Reliable state management with Chrome Storage API
- **Type-Safe Code**: Full TypeScript implementation with comprehensive type definitions

### Key Components

```
src/
├── core/
│   └── extension-core.ts        # Main extension orchestrator
├── managers/
│   ├── tab-manager.ts           # MRU tab ordering and operations
│   ├── window-manager.ts        # Window state tracking
│   ├── service-worker-manager.ts # Service worker lifecycle
│   ├── settings-manager.ts      # Configuration management
│   └── storage-manager.ts       # Data persistence
├── ui/
│   └── options-ui.ts           # Options page interface
└── utils/
    └── logger.ts               # Debug logging utilities
```

### Performance Features

- **Smart Reconciliation**: Automatic state recovery after service worker dormancy
- **Retry Logic**: Robust tab operations with drag-and-drop handling
- **Minimal Memory**: Efficient data structures and cleanup procedures
- **Error Recovery**: Graceful handling of Chrome API limitations

## 🔧 Development

### Prerequisites

- Node.js 16+ and npm
- Chrome Browser
- PowerShell (for build scripts)

### Setup

```bash
# Clone the repository
git clone https://github.com/kamyaw010/FLST-Chrome-Revive.git
cd flst-chrome-revive

# Install dependencies
npm install

# Development build with watch mode
npm run build:watch

# Production build
npm run build:prod
```

### Build Scripts

- `npm run build` - TypeScript compilation only
- `npm run build:dev` - Development build with full packaging
- `npm run build:prod` - Production build with zip generation
- `npm run build:watch` - Watch mode for development
- `npm run build:clean` - Clean all build artifacts

### Project Structure

```
├── src/                  # TypeScript source code
├── dist/                 # Compiled extension files
├── build/               # Production zip packages
├── img/                 # Extension icons
├── options.html         # Options page template
├── options.css          # Options page styles
├── manifest.json        # Extension manifest
├── build.ps1           # PowerShell build script
└── tsconfig.json       # TypeScript configuration
```

## 🧪 Testing

### Manual Testing Checklist

- [ ] Tab flipping with `Alt+N` works correctly
- [ ] Closing tabs selects MRU tab when flipping is enabled
- [ ] New tab behavior respects configuration settings
- [ ] Options page saves and loads settings properly
- [ ] Extension survives browser restart
- [ ] Service worker reactivation functions correctly

### Debugging

Enable debug logging by modifying `src/utils/logger.ts`:

```typescript
private isEnabled: boolean = true; // Enable for debugging
```

## 📋 Version History

### v3.1.0 (Current)

- ✅ Message-based service worker reactivation detection
- ✅ Enhanced build script with production zip cleanup
- ✅ Optimized permissions (minimal required permissions)
- ✅ Improved error handling and retry logic
- ✅ Type-safe activation handling with enums

### v3.0.3

- ✅ MRU reconciliation system for service worker reactivation
- ✅ Comprehensive tab state management
- ✅ Enhanced window tracking

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Follow TypeScript best practices
- Maintain comprehensive error handling
- Add appropriate logging for debugging
- Test across different Chrome versions
- Update documentation for new features

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Inspired by the original FLST extension concept
- Built with modern Chrome Extension Manifest V3 standards
- Uses Chrome's native APIs for optimal performance

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/kamyaw010/FLST-Chrome-Revive/issues)
- **Chrome Web Store**: [Extension Page](https://chromewebstore.google.com/detail/flst-chrome-revive/alipmjpidmffnmkccdacnlfllkeogapb)

---

**Made with ❤️ for Chrome users who want better tab management**
