const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('ssh2');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TTY-Style Web SSH</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background-color: #0d1117;
            color: #c9d1d9;
            font-family: 'Courier New', Courier, monospace;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .top-bar {
            background: #161b22;
            padding: 10px 15px;
            display: flex;
            gap: 10px;
            align-items: center;
            border-bottom: 1px solid #30363d;
            flex-wrap: wrap;
        }
        input {
            background: #0d1117;
            border: 1px solid #30363d;
            color: #58a6ff;
            padding: 6px 10px;
            border-radius: 4px;
            font-family: inherit;
            font-size: 13px;
        }
        input:focus { border-color: #58a6ff; outline: none; }
        .btn {
            padding: 6px 15px;
            border: none;
            border-radius: 4px;
            font-weight: bold;
            cursor: pointer;
            font-size: 13px;
        }
        .btn-connect { background: #238636; color: #fff; }
        .btn-connect:hover { background: #2ea043; }
        .btn-disconnect { background: #da3633; color: #fff; display: none; }
        .btn-disconnect:hover { background: #f85149; }
        #status-bar {
            background: #161b22;
            color: #8b949e;
            padding: 4px 15px;
            font-size: 12px;
            border-bottom: 1px solid #21262d;
        }
        #terminal-container {
            flex: 1;
            padding: 5px;
            background: #000;
        }
    </style>
</head>
<body>

    <div class="top-bar">
        <input type="text" id="host" placeholder="Host / IP" style="width: 150px;">
        <input type="number" id="port" placeholder="Port" value="22" style="width: 70px;">
        <input type="text" id="username" placeholder="User" value="root" style="width: 100px;">
        <input type="password" id="password" placeholder="Password" style="width: 120px;">
        <button id="conn-btn" class="btn btn-connect" onclick="toggleConnect()">Connect</button>
        <button id="disc-btn" class="btn btn-disconnect" onclick="disconnectSSH()">Disconnect</button>
    </div>

    <div id="status-bar">Status: Offline</div>
    <div id="terminal-container"></div>

    <script src="/socket.io/socket.io.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
    <script>
        const socket = io();
        let connected = false;

        const term = new Terminal({
            cursorBlink: true,
            fontSize: 15,
            fontFamily: 'Consolas, monospace',
            theme: {
                background: '#000000',
                foreground: '#00FF66', // تم کلاسیک سبز ترمینال
                cursor: '#00FF66'
            }
        });

        term.open(document.getElementById('terminal-container'));

        function toggleConnect() {
            const host = document.getElementById('host').value.trim();
            const port = document.getElementById('port').value.trim();
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value;

            if (!host || !username || !password) {
                alert('Fill in Host, Username, and Password');
                return;
            }

            setStatus('Connecting...');
            term.clear();

            socket.emit('ssh-connect', {
                host, port, username, password,
                cols: term.cols,
                rows: term.rows
            });
        }

        function disconnectSSH() {
            socket.emit('ssh-disconnect');
        }

        function setStatus(msg) {
            document.getElementById('status-bar').innerText = 'Status: ' + msg;
        }

        term.onData(data => {
            if (connected) socket.emit('terminal-input', data);
        });

        socket.on('terminal-output', data => term.write(data));

        socket.on('status', data => {
            setStatus(data.msg);
            if (data.connected !== undefined) {
                connected = data.connected;
                document.getElementById('conn-btn').style.display = connected ? 'none' : 'inline-block';
                document.getElementById('disc-btn').style.display = connected ? 'inline-block' : 'none';
            }
        });

        // تنظیم خودکار سایز ترمینال
        window.addEventListener('resize', () => {
            if (connected) {
                socket.emit('terminal-resize', { cols: term.cols, rows: term.rows });
            }
        });
    </script>
</body>
</html>
  `);
});

io.on('connection', (socket) => {
    let sshClient = null;
    let streamRef = null;

    socket.on('ssh-connect', (data) => {
        if (sshClient) sshClient.end();

        sshClient = new Client();
        const { host, port, username, password, cols, rows } = data;

        sshClient.on('ready', () => {
            socket.emit('status', { msg: 'Connected to ' + host, connected: true });

            sshClient.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
                if (err) {
                    socket.emit('status', { msg: 'Shell Error: ' + err.message, connected: false });
                    return;
                }

                streamRef = stream;

                stream.on('data', (d) => socket.emit('terminal-output', d.toString('binary')));
                stream.stderr.on('data', (d) => socket.emit('terminal-output', d.toString('binary')));

                socket.on('terminal-input', (input) => {
                    if (streamRef) streamRef.write(input);
                });

                socket.on('terminal-resize', (size) => {
                    if (streamRef) streamRef.setWindow(size.rows, size.cols, 0, 0);
                });

                stream.on('close', () => {
                    sshClient.end();
                    socket.emit('status', { msg: 'Disconnected', connected: false });
                });
            });
        }).on('error', (err) => {
            socket.emit('status', { msg: 'Connection Failed: ' + err.message, connected: false });
        }).connect({
            host: host,
            port: parseInt(port) || 22,
            username: username,
            password: password,
            readyTimeout: 15000
        });
    });

    socket.on('ssh-disconnect', () => {
        if (sshClient) {
            sshClient.end();
            socket.emit('status', { msg: 'Disconnected by user', connected: false });
        }
    });

    socket.on('disconnect', () => {
        if (sshClient) sshClient.end();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on port ${PORT}`));
