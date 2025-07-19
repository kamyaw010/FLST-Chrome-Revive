# Build script for FLST Chrome Extension

param(
    [string]$Mode = "development",
    [switch]$Watch = $false,
    [switch]$Clean = $false
)

# Set error action preference
$ErrorActionPreference = "Stop"

# Read version from manifest.json
$manifestContent = Get-Content "manifest.json" -Raw | ConvertFrom-Json
$version = $manifestContent.version -replace '\.', '_'
$projectName = "FLST Chrome Revive"

# Colors for output
$Color_Info = "Cyan"
$Color_Success = "Green"
$Color_Warning = "Yellow"
$Color_Error = "Red"

function Write-Info($Message) {
    Write-Host "ℹ️  $Message" -ForegroundColor $Color_Info
}

function Write-Success($Message) {
    Write-Host "✅ $Message" -ForegroundColor $Color_Success
}

function Write-Warning($Message) {
    Write-Host "⚠️  $Message" -ForegroundColor $Color_Warning
}

function Write-Error($Message) {
    Write-Host "❌ $Message" -ForegroundColor $Color_Error
}

# Clean build directory
if ($Clean) {
    Write-Info "Cleaning build directories..."
    if (Test-Path "dist") { Remove-Item "dist" -Recurse -Force }
    if (Test-Path "build") { Remove-Item "build" -Recurse -Force }
    Write-Success "Build directories cleaned"
}

# Create directories
Write-Info "Creating build directories..."
New-Item -ItemType Directory -Force -Path "dist" | Out-Null
New-Item -ItemType Directory -Force -Path "build" | Out-Null

# Compile TypeScript
Write-Info "Compiling TypeScript..."
try {
    if ($Watch) {
        Write-Info "Starting TypeScript compiler in watch mode..."
        npx tsc --watch
    }
    else {
        npx tsc
        Write-Success "TypeScript compilation completed"
    }
}
catch {
    Write-Error "TypeScript compilation failed: $_"
    exit 1
}

if (-not $Watch) {
    # Copy static files
    Write-Info "Copying static files..."

    # Copy manifest
    Copy-Item "manifest.json" "dist/" -Force

    # Copy images
    Copy-Item "img" "dist/img" -Recurse -Force

    # Copy HTML and CSS from root to dist
    Copy-Item "options.html" "dist/" -Force
    Copy-Item "options.css" "dist/" -Force

    Write-Success "Static files copied"

    # Create build package
    Write-Info "Creating build package..."
    $packageName = "${projectName}_${version}.zip"
    $packagePath = "build/$packageName"

    # For production builds, clean up existing zip files first
    if ($Mode -eq "production") {
        Write-Info "Cleaning existing zip files from build folder..."
        Get-ChildItem "build" -Filter "*.zip" | Remove-Item -Force
        Write-Success "Existing zip files removed"
    }
    else {
        # For development builds, only remove the specific file if it exists
        if (Test-Path $packagePath) {
            Remove-Item $packagePath -Force
        }
    }

    # Create zip for distribution
    Compress-Archive -Path "dist/*" -DestinationPath $packagePath -Force
    Write-Success "Build package created: $packagePath"

    # Show build summary
    Write-Info "Build Summary:"
    Write-Host "  Project: $projectName" -ForegroundColor White
    Write-Host "  Version: $($manifestContent.version)" -ForegroundColor White
    Write-Host "  Mode: $Mode" -ForegroundColor White
    Write-Host "  Output: dist/" -ForegroundColor White
    Write-Host "  Package: $packagePath" -ForegroundColor White

    $distSize = (Get-ChildItem "dist" -Recurse | Measure-Object -Property Length -Sum).Sum
    $distSizeKB = [math]::Round($distSize / 1KB, 2)
    Write-Host "  Size: $distSizeKB KB" -ForegroundColor White

    Write-Success "Build completed successfully!"
}
