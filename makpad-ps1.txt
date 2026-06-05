param(
    [Parameter(Position=0, Mandatory=$true)]
    [string]$BlockName,

    [Parameter(Position=1)]
    [string]$Text = $null,

    [switch]$Append,
    [switch]$Files,
    [string]$Upload = $null,
    [string]$Download = $null,
    [string]$OutFile = $null
)

$apiBase = "https://makpad.mapazero.com/api"
$noteUrl = "$apiBase/note/$BlockName"
$filesUrl = "$apiBase/files/$BlockName"

function Assert-AttachmentsEnabled {
    $config = Invoke-RestMethod -Uri "$apiBase/public/config" -Method GET
    if (-not $config.attachmentsEnabled) {
        Write-Error "Attachments are disabled for this MAKPAD installation."
        exit 1
    }
}

if ($Files) {
    Assert-AttachmentsEnabled
    $result = Invoke-WebRequest -Uri $filesUrl -Method GET -UseBasicParsing
    Write-Host $result.Content
    exit
}

if ($Upload) {
    Assert-AttachmentsEnabled
    if (-not (Test-Path $Upload)) {
        Write-Error "Arquivo nao encontrado: $Upload"
        exit 1
    }

    $form = @{ file = Get-Item $Upload }
    $result = Invoke-WebRequest -Uri $filesUrl -Method POST -Form $form -UseBasicParsing
    Write-Host $result.Content
    exit
}

if ($Download) {
    Assert-AttachmentsEnabled
    $downloadUrl = "$apiBase/download/$Download`?slug=$BlockName"
    $target = $OutFile
    if (-not $target) { $target = $Download }
    Invoke-WebRequest -Uri $downloadUrl -Method GET -OutFile $target -UseBasicParsing
    Write-Host "Arquivo salvo em $target"
    exit
}

if ([Console]::IsInputRedirected) {
    $pipedText = [Console]::In.ReadToEnd()
    if ($Append) {
        $current = ""
        try {
            $current = (Invoke-WebRequest -Uri $noteUrl -Method GET -UseBasicParsing -ErrorAction Ignore).Content
        } catch {}

        if ($current) {
            $pipedText = $current + "`n" + $pipedText
        }
    }

    Invoke-WebRequest -Uri $noteUrl -Method PUT -BodyMode "Raw" -Body $pipedText -ContentType "text/plain" -UseBasicParsing | Out-Null
} else {
    if ($Text) {
        Invoke-WebRequest -Uri $noteUrl -Method PUT -Body $Text -ContentType "text/plain" -UseBasicParsing | Out-Null
    } else {
        try {
            $output = (Invoke-WebRequest -Uri $noteUrl -Method GET -UseBasicParsing -ErrorAction Ignore).Content
            if ($output) { Write-Host $output }
        } catch {}
    }
}
