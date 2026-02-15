# OpenBot Desktop Application

A professional desktop application for managing and executing AI agents with real-time chat, session management, and skills browsing.

## 🚀 Features

- **Real-time Agent Chat**: Stream responses from AI agents with live tool execution visualization
- **Session Management**: Create, manage, and switch between multiple agent sessions
- **Skills Browser**: Browse and explore available agent skills with detailed documentation
- **Professional UI**: Modern glassmorphism design with dark/light theme support
- **WebSocket Integration**: Real-time communication with OpenBot gateway service
- **Configuration Management**: Flexible agent and workspace configuration

## 📋 Prerequisites

- Node.js >= 20.0.0
- npm or yarn
- OpenBot gateway service running

## 🛠️ Installation

### 1. Install Dependencies

From the openbot root directory:

```bash
# Install desktop app dependencies
npm run desktop:install

# Or install manually
cd desktop
npm install
cd server && npm install
cd ../renderer && npm install
```

### 2. Build OpenBot Core

```bash
# From openbot root
npm install
npm run build
```

## 🎯 Usage

### Development Mode

Start all services in development mode:

```bash
# Terminal 1: Start OpenBot Gateway
npm run build
node dist/gateway/server.js

# Terminal 2: Start Desktop App (from openbot root)
npm run desktop:dev

# Or from desktop directory
cd desktop
npm run dev
```

This will start:
- NestJS backend on `http://localhost:38081`
- Vue.js frontend on `http://localhost:5173`
- Electron desktop window

### Production Build

```bash
cd desktop
npm run build
```

## 🏗️ Architecture

### Backend (NestJS)

- **Agents Module**: Session management and gateway integration
- **Skills Module**: Skills browsing and documentation
- **Config Module**: Application configuration management
- **WebSocket Gateway**: Real-time event streaming

### Frontend (Vue.js)

- **Dashboard**: Overview and quick actions
- **Agent Chat**: Real-time chat interface with streaming
- **Sessions**: Session management and history
- **Skills**: Skills browser with modal details
- **Configuration**: Agent and workspace settings
- **Settings**: Application preferences

### Communication Flow

```
Desktop UI (Vue.js)
    ↓ HTTP/WebSocket
NestJS Backend
    ↓ WebSocket
OpenBot Gateway
    ↓
Agent Manager
```

## 📁 Directory Structure

```
apps/desktop/
├── main.js                 # Electron main process
├── preload.js             # Electron preload script
├── package.json           # Root dependencies
├── server/                # NestJS backend
│   ├── src/
│   │   ├── agents/       # Agent management
│   │   ├── skills/       # Skills browsing
│   │   ├── config/       # Configuration
│   │   └── main.ts       # Entry point
│   └── package.json
└── renderer/             # Vue.js frontend
    ├── src/
    │   ├── views/        # Page components
    │   ├── components/   # Reusable components
    │   ├── store/        # Pinia state management
    │   ├── router/       # Vue Router
    │   ├── api/          # API client
    │   └── assets/       # Styles and assets
    └── package.json
```

## 🎨 Design System

The application uses a professional design system with:

- **Glassmorphism effects**: Modern translucent UI elements
- **Gradient accents**: Vibrant color gradients for primary actions
- **Smooth animations**: Fade, slide, and pulse animations
- **Dark/Light themes**: Automatic theme switching
- **Typography**: Inter for UI, Roboto Mono for code
- **Responsive layouts**: Adapts to different window sizes

## 🔧 Configuration

Configuration is stored in `~/.openbot/desktop/config.json`:

```json
{
  "gatewayUrl": "ws://localhost:38080",
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-chat",
  "defaultAgentId": "default",
  "theme": "dark"
}
```

（`defaultAgentId` 表示缺省智能体 id。）

## 🐛 Troubleshooting

### Gateway Connection Issues

If the desktop app can't connect to the gateway:

1. Ensure the gateway is running: `node dist/gateway/server.js`
2. Check the gateway URL in Configuration
3. Verify no firewall is blocking port 38080

### Build Errors

```bash
# Clean and rebuild
cd desktop
rm -rf node_modules server/node_modules renderer/node_modules
npm install
```

### WebSocket Not Connecting

Check that:
- NestJS backend is running on port 38081
- Frontend is connecting to the correct backend URL
- CORS is properly configured

## 📝 Development Tips

### Hot Reload

All three services support hot reload:
- Electron: Restart on main process changes
- NestJS: Auto-restart on file changes
- Vue.js: Hot module replacement

### Debugging

- **Frontend**: Open DevTools in Electron window (Cmd/Ctrl+Shift+I)
- **Backend**: Check NestJS console output
- **Gateway**: Check gateway server logs

## 🚢 Building for Production

```bash
cd apps/desktop
npm run build
```

This creates platform-specific installers in `apps/desktop/dist/`.

## 📄 License

MIT
