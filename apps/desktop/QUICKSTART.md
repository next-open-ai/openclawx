# OpenBot Desktop - Quick Start Guide

## 🚀 Running the Application

You need **3 terminals** to run the complete application:

### Terminal 1: OpenBot Gateway
```bash
cd /Users/ctrip/code/test/gravity/openbot
node dist/cli/cli.js gateway
```

**Expected output:**
```
Starting gateway server on port 38080...
✅ Gateway server listening on ws://localhost:38080
   Health check: http://localhost:38080/health
```

### Terminal 2: Desktop Application
```bash
cd /Users/ctrip/code/test/gravity/openbot
npm run desktop:dev
```

**Expected output:**
```
[0] NestJS backend starting...
[1] Vite dev server ready at http://localhost:5173/
[2] Electron window opening...
```

### Terminal 3: (Optional) Build OpenBot if needed
```bash
cd /Users/ctrip/code/test/gravity/openbot
npm run build
```

## ✅ Verification

Once all services are running:

1. **Electron window** should open automatically
2. **Dashboard** should be visible with stats
3. **Gateway connection** should show in Terminal 1:
   ```
   New connection: <uuid> from ::1
   Client <uuid> connected with session <session-id>
   ```

## 🎯 Testing the Application

### 1. Create a Session
- Click "New Session" button on Dashboard
- Or navigate to "Agent Chat" from sidebar

### 2. Send a Message
- Type: "Hello, what can you do?"
- Press Enter or click "Send"
- Watch the streaming response appear in real-time

### 3. View Tool Executions
- Tool calls will appear as expandable cards
- Click to see arguments and results

### 4. Browse Skills
- Navigate to "Skills" from sidebar
- Click on any skill card to view documentation

### 5. Configure Settings
- Go to "Configuration" to change model/provider
- Go to "Settings" to toggle theme

## 🐛 Troubleshooting

### Gateway Connection Failed
**Error:** `ECONNREFUSED 127.0.0.1:38080`

**Solution:** Make sure Terminal 1 (gateway) is running first

### Desktop App Won't Start
**Error:** Port already in use

**Solution:** 
```bash
# Kill existing processes
pkill -f "node dist/cli/cli.js gateway"
pkill -f "npm run desktop:dev"
```

### Electron Window Doesn't Open
**Solution:** Check Terminal 2 for errors, try:
```bash
cd desktop
rm -rf node_modules
npm install
```

## 📝 Notes

- **Gateway must start first** before desktop app
- **Auto-reconnect** is enabled for gateway disconnections
- **DevTools** opens automatically in development mode (Cmd/Ctrl+Shift+I)
- **Hot reload** is enabled for all components

## 🎨 Features to Try

- ✅ Create multiple sessions
- ✅ Switch between sessions
- ✅ Send messages with markdown
- ✅ View real-time tool executions
- ✅ Browse available skills
- ✅ Toggle dark/light theme
- ✅ Configure model and provider
- ✅ Delete old sessions

## 🔄 Restart Everything

If something goes wrong:

```bash
# Terminal 1
Ctrl+C  # Stop gateway
node dist/cli/cli.js gateway  # Restart

# Terminal 2  
Ctrl+C  # Stop desktop app
npm run desktop:dev  # Restart
```

---

**Enjoy your OpenBot Desktop application! 🎉**
