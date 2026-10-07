#Requires -Version 7
<#
.SYNOPSIS
  Проверить плагин, установить в D:\apps\MessageChapters, подключить ко всем сессиям Claude,
  по желанию выпустить релиз на GitHub.

.DESCRIPTION
  Шаги:
    1. claude plugin validate и claude plugin test — тем же движком, что у Claude Desktop
    2. очистить D:\apps\<Name>, скопировать манифест и модуль хуков (без тестов),
       записать SOURCE.txt (репозиторий, коммит, версия, дата)
    3. добавить D:\apps\<Name> в env.CLAUDE_CODE_PLUGIN_DIRS в ~/.claude/settings.json
       (если его там ещё нет; перед изменением — копия settings.json.bak)
    4. с -Release: zip установленной папки + gh release create v<версия> с заметками из CHANGELOG.md

  Новые сессии Claude подхватывают плагин сами; уже открытые — только после перезапуска.

.PARAMETER Release
  Выпустить релиз на GitHub (нужен авторизованный gh, чистое дерево и закоммиченная версия).
.PARAMETER AppsDir
  Куда ставить. По умолчанию D:\apps.
#>
[CmdletBinding()]
param(
    [switch]$Release,
    [string]$AppsDir = 'D:\apps'
)

$ErrorActionPreference = 'Stop'
$Name = 'MessageChapters'
$Root = $PSScriptRoot
$Target = Join-Path $AppsDir $Name
Set-Location $Root

# --- версия из манифеста плагина --------------------------------------------
$Version = (Get-Content '.claude-plugin\plugin.json' -Raw | ConvertFrom-Json).version
if (-not $Version) { throw 'В .claude-plugin\plugin.json не найдена version' }
Write-Host "== $Name v$Version" -ForegroundColor Cyan

# --- проверки ---------------------------------------------------------------
# Берём claude.exe из Claude Desktop: плагин исполняет именно он, а claude в PATH
# бывает старее и не знает нужных событий.
function Find-Claude {
    $base = Join-Path $env:APPDATA 'Claude\claude-code'
    if (Test-Path $base) {
        $newest = Get-ChildItem $base -Directory |
            Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending |
            Select-Object -First 1
        if ($newest) {
            $exe = Get-ChildItem $newest.FullName -Recurse -Filter 'claude.exe' | Select-Object -First 1
            if ($exe) { return $exe.FullName }
        }
    }
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'claude не найден ни в Claude Desktop, ни в PATH'
}
$Claude = Find-Claude
Write-Host "-- движок: $Claude ($(& $Claude --version))"
Write-Host '-- claude plugin validate'
& $Claude plugin validate $Root
if ($LASTEXITCODE) { throw 'Проверка плагина не прошла' }
Write-Host '-- claude plugin test'
& $Claude plugin test $Root
if ($LASTEXITCODE) { throw 'Тесты не прошли' }

# --- установка --------------------------------------------------------------
Write-Host "-- установка в $Target"
New-Item -ItemType Directory -Force $Target | Out-Null
Get-ChildItem $Target -Force | Remove-Item -Recurse -Force
New-Item -ItemType Directory -Force (Join-Path $Target '.claude-plugin'), (Join-Path $Target 'hooks') | Out-Null
Copy-Item '.claude-plugin\plugin.json' (Join-Path $Target '.claude-plugin')
Get-ChildItem 'hooks' -File | Where-Object { $_.Name -notmatch '\.test\.' } |
    Copy-Item -Destination (Join-Path $Target 'hooks')

$commit = (git rev-parse --short HEAD 2>$null); if (-not $commit) { $commit = 'нет коммитов' }
$dirty = if (git status --porcelain 2>$null) { ' (есть незакоммиченные изменения)' } else { '' }
$repo = (git remote get-url origin 2>$null); if (-not $repo) { $repo = 'нет remote' }
@"
name:    $Name
version: $Version
repo:    $repo
commit:  $commit$dirty
built:   $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
source:  $Root
"@ | Set-Content (Join-Path $Target 'SOURCE.txt') -Encoding UTF8

# --- подключение ко всем сессиям ------------------------------------------
$settingsPath = Join-Path $HOME '.claude\settings.json'
$settings = if (Test-Path $settingsPath) { Get-Content $settingsPath -Raw | ConvertFrom-Json -AsHashtable } else { [ordered]@{} }
if (-not $settings.Contains('env')) { $settings['env'] = [ordered]@{} }
$dirs = @(([string]$settings['env']['CLAUDE_CODE_PLUGIN_DIRS']) -split ';' | Where-Object { $_ })
if ($dirs -contains $Target) {
    Write-Host "-- $Target уже в CLAUDE_CODE_PLUGIN_DIRS"
} else {
    if (Test-Path $settingsPath) { Copy-Item $settingsPath "$settingsPath.bak" -Force }
    $settings['env']['CLAUDE_CODE_PLUGIN_DIRS'] = (@($dirs) + $Target) -join ';'
    # Переводы строк LF, как у файла, который пишет сам Claude.
    $json = ($settings | ConvertTo-Json -Depth 64) -replace "`r`n", "`n"
    [IO.File]::WriteAllText($settingsPath, "$json`n", [Text.UTF8Encoding]::new($false))
    Write-Host "-- $Target добавлен в CLAUDE_CODE_PLUGIN_DIRS ($settingsPath, копия в .bak)"
}
Write-Host '-- готово: новые сессии Claude подхватят плагин, открытые — после перезапуска' -ForegroundColor Green

# --- релиз ------------------------------------------------------------------
if ($Release) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh не найден — релиз невозможен' }
    if (git status --porcelain) { throw 'Есть незакоммиченные изменения — сначала закоммить' }
    $tag = "v$Version"
    $dist = Join-Path $Root 'dist'
    New-Item -ItemType Directory -Force $dist | Out-Null
    $zip = Join-Path $dist "$Name-$tag.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $Target '*') -DestinationPath $zip
    # Заметки — раздел CHANGELOG.md для этой версии (до следующего заголовка "## ").
    $changelog = Get-Content 'CHANGELOG.md' -Raw
    $notes = if ($changelog -match "(?ms)^## \[$([regex]::Escape($Version))\][^\n]*\n(.*?)(?=^## \[|\z)") { $Matches[1].Trim() } else { "Release $tag" }
    $notesFile = Join-Path $env:TEMP "$Name-release-notes.md"
    $notes | Set-Content $notesFile -Encoding UTF8
    if (-not (git tag --list $tag)) { git tag -a $tag -m $tag; git push origin $tag }
    gh release create $tag $zip --title $tag --notes-file $notesFile
    if ($LASTEXITCODE) { throw 'gh release create не удался' }
    Write-Host "-- релиз $tag опубликован" -ForegroundColor Green
}

# Код выхода git-команд выше (например, «нет коммитов») не должен выдавать успех за ошибку.
exit 0
