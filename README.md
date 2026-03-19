# 🏀 NBA Daily Advanced Metrics Report

Automatically runs every morning at 8AM ET via GitHub Actions.  
Fetches every game from the night before, ranks players by Performance Index, and delivers:
- 📧 Rich HTML email with top 10 breakdown
- 🌐 Live dashboard at `your-username.github.io/nba-daily-report`

---

## ▶️ Running the Report

> **Which branch?**  
> Always run the report from the **`main` branch** (your repository's default branch).  
> GitHub Actions `schedule` and `workflow_dispatch` events are only triggered from the default branch. If the workflow file isn't on `main`, automated runs will not start.

### Manual run (any time)
1. Go to your repo on GitHub and click the **Actions** tab
2. In the left sidebar, click **NBA Daily Report**
3. Click the **Run workflow** dropdown → make sure **Branch: main** is selected → **Run workflow**
4. The job takes ~2 minutes — then check your inbox and your dashboard

### Automatic run
The workflow fires automatically every day at **8:00 AM Eastern** (13:00 UTC). No action needed after setup.

> **Not seeing the "Run workflow" button?**  
> Make sure the file `.github/workflows/nba-daily.yml` exists **on the `main` branch** of your repository. If you only have `nba-daily.yml` in the root, or the file is only on another branch, GitHub Actions won't detect it. See the setup steps below to fix this.

---

## Setup (15 minutes)

### Step 1 — Fork / Create this repo on GitHub
1. Go to [github.com](https://github.com) and create a new repository named `nba-daily-report`
2. Upload all these files, keeping the folder structure intact

### Step 2 — Get your free API keys

#### Sportradar NBA API (free trial)
1. Go to [developer.sportradar.com](https://developer.sportradar.com)
2. Sign up for a free account
3. Go to **My Applications** → **Add Application**
4. Select **NBA Trial** → copy your API key

#### SendGrid Email (free — 100 emails/day)
1. Go to [sendgrid.com](https://sendgrid.com) and create a free account
2. Go to **Settings → API Keys → Create API Key**
3. Choose **Full Access** → copy your key
4. Go to **Settings → Sender Authentication** and verify your email address

#### Anthropic Claude API
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Go to **API Keys** → **Create Key** → copy it

### Step 3 — Add secrets to GitHub
1. In your GitHub repo, go to **Settings → Secrets and variables → Actions**
2. Click **New repository secret** and add each of these:

| Secret Name | Value |
|---|---|
| `SPORTRADAR_API_KEY` | Your Sportradar trial key |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `SENDGRID_API_KEY` | Your SendGrid API key |
| `REPORT_EMAIL_TO` | Email to receive the report (e.g. you@gmail.com) |
| `REPORT_EMAIL_FROM` | Verified SendGrid sender email |

### Step 4 — Enable GitHub Pages
1. In your repo, go to **Settings → Pages**
2. Under **Source**, select **GitHub Actions**
3. Click **Save**

Your dashboard will be live at:  
`https://YOUR-USERNAME.github.io/NBA-daily-report`

### Step 5 — Test it manually
1. Go to **Actions** tab in your repo
2. Click **NBA Daily Report** workflow
3. Click **Run workflow** → **Run workflow**
4. Watch it run — check your email and dashboard after ~2 minutes

---

## How It Works

```
8:00 AM ET every day
       ↓
GitHub Actions wakes up
       ↓
Fetches all last night's games (Sportradar)
       ↓
Fetches box score for every game
       ↓
Computes Performance Index for every player:
  PTS×1 + REB×1.2 + AST×1.5 + STL×3 + BLK×2.5
  − TO×2 + TS%Δ×0.3 + Off/Def Rating Impact
  + Second chance pts + Fast break pts
  + Ast/TO ratio bonus + D-hold bonus + DD/TD bonus
       ↓
Ranks all players → Top 10
       ↓
Claude AI writes analyst commentary
       ↓
Sends HTML email via SendGrid
       ↓
Deploys dashboard to GitHub Pages
```

## Performance Index Formula

| Component | Weight |
|---|---|
| Points | ×1.0 |
| Rebounds | ×1.2 |
| Assists | ×1.5 |
| Steals | ×3.0 |
| Blocks | ×2.5 |
| Turnovers | ×−2.0 |
| TS% vs 55% baseline | ×0.3 per point |
| Offensive Rating impact | ×2.0 |
| Defensive Rating impact | ×2.0 |
| Second-chance pts | ×0.8 |
| Fast break pts | ×0.5 |
| Net +/− | ×0.4 |
| Elite AST/TO ratio (≥4:1) | +5 bonus |
| Double-double | +5 bonus |
| Triple-double | +12 bonus |
| DefRtg < 98 (20+ mins) | +6 bonus |
| 4+ combined STL+BLK | +4 bonus |

## Schedule

Runs at **8:00 AM Eastern** every day (13:00 UTC).  
To change the time, edit `.github/workflows/nba-daily.yml` and update the cron expression.

## Costs

| Service | Cost |
|---|---|
| GitHub Actions | Free (2,000 min/month) |
| Sportradar NBA Trial | Free (1,000 API calls/month) |
| SendGrid | Free (100 emails/day) |
| Anthropic Claude | ~$0.01 per report |
| GitHub Pages | Free |

**Total: ~$0.30/month** (just the Claude API calls)
