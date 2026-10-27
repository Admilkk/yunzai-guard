param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -eq "Desktop") {
  Add-Type -AssemblyName System.Security
} else {
  Add-Type -AssemblyName System.Security.Cryptography.Xml
}
$document = [System.Xml.XmlDocument]::new()
$document.PreserveWhitespace = $true
$document.XmlResolver = $null
$document.Load((Resolve-Path -LiteralPath $Path))
$signature = [System.Security.Cryptography.Xml.SignedXml]::new($document)
$signature.LoadXml($document.DocumentElement)
$certificateText = $document.SelectSingleNode('//*[local-name()="X509Certificate"]').InnerText
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
  [Convert]::FromBase64String($certificateText)
)
$chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
# 这里只复核固定构建工具，不验证当前吊销状态或 RFC 3161 时间戳。
# 执行前仍须通过当前 Windows Authenticode 校验。
$chain.ChainPolicy.RevocationMode = "NoCheck"
$chain.ChainPolicy.VerificationTime = [datetime]"2025-06-04T11:19:43Z"
$valid = $signature.CheckSignature($certificate, $true)
$chainValid = $chain.Build($certificate)
$root = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
if (!$valid -or !$chainValid -or
  $certificate.Thumbprint -ne "8B6B879690F7277A7B2FC0B965094DBA27AB313B" -or
  $root.Thumbprint -ne "3B1EFD3A66EA28B16697394703A72CA340A05BD5") {
  throw "Pinned Microsoft VSIX signed manifest validation failed"
}
[ordered]@{
  signatureValid = $valid
  chainAtSigningPeriodValid = $chainValid
  revocationChecked = $false
  verificationTime = "2025-06-04T11:19:43Z"
  certificateThumbprint = $certificate.Thumbprint
  certificateSubject = $certificate.Subject
  rootThumbprint = $root.Thumbprint
} | ConvertTo-Json
