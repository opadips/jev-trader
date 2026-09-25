# VPS setup (one time, about 15 minutes)

The cloud session never logs in to the server. GitHub is the only bridge:

```
cloud session --push code--> GitHub (branch vps) <--pull every 5 min-- VPS agent
cloud session <--read------- GitHub (reports repo) <--push hourly----- VPS agent
```

On the server everything runs as a new user `jev` with no sudo and no docker access, so it cannot
touch your other services. It opens no public ports (the recorder's health check is loopback only).

The agent (`deploy/vps-agent.sh`) only ever: pulls the `vps` branch, runs `bun install` and
`bun test`, restarts the recorder if the tests pass (rolls back if not), and pushes a status report.

## What you need

- A Linux server with systemd, `git` and `curl` (Ubuntu or Debian are fine).
- A few GB of free disk (the recording grows about 300 MB a day).
- Port 3101 free on 127.0.0.1: `ss -ltn | grep ':3101 '` should print nothing.
- The `vps` branch existing in `opadips/jev-trader` (the cloud session creates it).

## 1. GitHub (in the browser)

1. Create a **private** repository `opadips/jev-trader-reports`, ticking "Add a README file".
2. Keep this tab open: you will add a deploy key to it in step 3.

## 2. Server, as root

```bash
adduser --disabled-password --gecos "" jev   # no sudo, not in the docker group
loginctl enable-linger jev                    # lets its services run without anyone logged in
```

## 3. Server, as jev

Open a shell as `jev` in a way that gives it a systemd user session:

```bash
machinectl shell jev@      # or: sudo -iu jev, then: export XDG_RUNTIME_DIR=/run/user/$(id -u)
```

Install Bun and make the key for the reports repo:

```bash
curl -fsSL https://bun.sh/install | bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/jev_reports -C "jev-vps reports"
cat ~/.ssh/jev_reports.pub
```

On GitHub, in `jev-trader-reports`: Settings > Deploy keys > Add deploy key. Paste the line
printed above, tick **Allow write access**, save. This key can write to that one repository only.

Point git at the key and clone both repositories:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-reports
  HostName github.com
  User git
  IdentityFile ~/.ssh/jev_reports
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh-keyscan github.com >> ~/.ssh/known_hosts

git clone -b vps https://github.com/opadips/jev-trader.git ~/jev-trader
git clone git@github-reports:opadips/jev-trader-reports.git ~/jev-reports
git -C ~/jev-reports config user.name "jev-vps"
git -C ~/jev-reports config user.email "jev-vps@localhost"
```

If your fork `opadips/jev-trader` is private, the first clone needs a key too: make
`~/.ssh/jev_code` the same way, add it to `jev-trader` as a deploy key **without** write access,
add a `Host github-code` block like the one above, and clone `git@github-code:opadips/jev-trader.git`.

Configure and test:

```bash
cd ~/jev-trader
~/.bun/bin/bun install --frozen-lockfile
~/.bun/bin/bun test
cp .env.example .env && chmod 600 .env
nano .env    # set TYPESAFE_AI_API_KEY (a fresh one); leave PRIVATE_KEY empty and DRY_RUN=true
```

Start the recorder and the agent:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/jev-recorder.service deploy/jev-agent.service deploy/jev-agent.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jev-recorder jev-agent.timer
```

## 4. Check it works

```bash
sleep 20; curl -s 127.0.0.1:3101/health | head -c 300; echo
systemctl --user start jev-agent       # first report now instead of in 5 minutes
tail -n 5 ~/jev-trader/data/recorder.log
```

Then open `jev-trader-reports` on GitHub: the README should show "Recording" and a venue table.
Tell the cloud session it is up; it will attach the reports repo and read it from then on.

## Day to day

- **Status:** the reports repo README, refreshed hourly and after every deploy.
- **Logs on the server:** `tail -f ~/jev-trader/data/recorder.log`, `systemctl --user status jev-recorder`.
- **Pause:** `systemctl --user stop jev-agent.timer jev-recorder`. **Resume:** `start` instead of `stop`.
- **Remove everything:** as `jev`, `systemctl --user disable --now jev-agent.timer jev-recorder`;
  then as root, `loginctl disable-linger jev && userdel -r jev`, and delete the deploy key on GitHub.
- The public Monad RPC allows about 25 requests a second per IP and the recorder uses about 13, so
  do not also run the demo from this server against the same public RPC.
