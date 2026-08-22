# OKF Workspace Engine

The Engine owns the Vault artifact model, deterministic workflows, Intake, Feeds, retrieval, background operations, API, worker, CLI, and deployable Workspace resources.

Production Vault content and runtime state live outside this package.

CLI commands that return JSON use an ASCII-safe JSON transport so the same output can be parsed by PowerShell 7 and Windows PowerShell 5.1 regardless of the active console code page. For example:

```powershell
$report = okf doctor --verbose | Out-String | ConvertFrom-Json
```

Unicode values are restored by the JSON parser; `\uXXXX` sequences in unparsed output are intentional.
