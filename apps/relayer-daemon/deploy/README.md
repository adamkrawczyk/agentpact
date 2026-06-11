# systemd deployment — agentpact-relayer-daemon

`settlement_2705` Phase F2 self-healing wiring. Use **systemd** (not pm2) so the
relayer survives a host reboot and auto-restarts on crash without a pm2 daemon
in the loop.

## Install (on the host that runs the relayer)

```bash
# 1. Build the daemon
cd /home/agentpact/agentpact
git pull
npm ci
npm run -w @agentpact/relayer-daemon build

# 2. Place env (NEVER commit this file — see apps/relayer-daemon/README.md for vars)
sudo install -d -m 750 /etc/agentpact
sudo install -m 600 /dev/null /etc/agentpact/relayer.env
sudo "$EDITOR" /etc/agentpact/relayer.env   # fill RELAYER_PRIVATE_KEY, DATABASE_URL, BASE_RPC_URL, ESCROW_V2_ADDRESS, PLATFORM_WALLET

# 3. Install + enable the unit
sudo cp apps/relayer-daemon/deploy/agentpact-relayer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agentpact-relayer

# 4. Verify
systemctl status agentpact-relayer --no-pager
curl -s http://127.0.0.1:4011/health | jq .
```

## Verify Restart=always actually works (F2 acceptance gate)

```bash
# Kill the process; systemd must bring it back within RestartSec.
sudo systemctl kill -s SIGKILL agentpact-relayer
sleep 12
systemctl is-active agentpact-relayer        # → active
curl -s http://127.0.0.1:4011/health | jq .  # → healthy again
```

If `is-active` returns `active` after a hard SIGKILL, the self-healing wiring is
proven. Record the result in `docs/DEPLOY_CHECKLIST.md`.

## Why systemd over pm2 here

- Survives host reboot with zero extra config (`WantedBy=multi-user.target`).
- No long-lived pm2 god-process whose own death silently stops restarts.
- `MemoryMax=` cgroup cap is a hard OOM ceiling (pm2 `--max-memory-restart` is
  a soft poll-based check that can miss a fast leak).
- Journald captures stdout/stderr with rotation for free (`journalctl -u agentpact-relayer`).
