# Ensure Prisma tables exist before starting services
pnpm run prisma-db-push

# Start Backend (New Window)
Start-Process -FilePath "pnpm" -ArgumentList "--filter ./apps/backend run dev"

# Start Frontend (New Window)
Start-Process -FilePath "pnpm" -ArgumentList "--filter ./apps/frontend run dev"

# Start Orchestrator (New Window)
Start-Process -FilePath "pnpm" -ArgumentList "--filter ./apps/orchestrator run dev"

# Start Social Auto Upload (New Window)
$sauPath = Join-Path (Get-Location) "social-auto-upload-main\social-auto-upload-main"
Start-Process -FilePath "cmd" -ArgumentList "/k cd /d $sauPath && python sau_backend.py"
