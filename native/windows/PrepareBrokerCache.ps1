param([Parameter(Mandatory = $true)][string]$Digest)
$ErrorActionPreference = "Stop"
if ($Digest -notmatch '^[a-f0-9]{64}$') { throw "Invalid broker source digest" }
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$base = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($base)) { throw "Private local application data is unavailable" }
function Assert-RealDirectory([string]$Path) {
  $cursor = $Path
  while ($cursor) {
    $attributes = [IO.File]::GetAttributes($cursor)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ($attributes -band [IO.FileAttributes]::Directory) -eq 0) {
      throw "Broker cache must use real directories"
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
Assert-RealDirectory $base
$current = $base
foreach ($part in @("YunzaiGuard", "WindowsSandboxBrokers", $Digest)) {
  $current = [IO.Path]::Combine($current, $part)
  if (-not [IO.Directory]::Exists($current)) {
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetOwner($owner)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($owner, $system)) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow)
      $security.AddAccessRule($rule)
    }
    [void][IO.Directory]::CreateDirectory($current, $security)
  }
  Assert-RealDirectory $current
  $acl = [IO.Directory]::GetAccessControl($current)
  if (-not $acl.AreAccessRulesProtected -or -not $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Equals($owner)) {
    throw "Broker cache owner or inheritance is not private"
  }
  $ownerFull = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        (-not $rule.IdentityReference.Equals($owner) -and -not $rule.IdentityReference.Equals($system))) {
      throw "Broker cache ACL is not owner-private"
    }
    if ($rule.IdentityReference.Equals($owner) -and
        ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) {
      $ownerFull = $true
    }
  }
  if (-not $ownerFull) { throw "Broker cache owner lacks full control" }
}
[Console]::WriteLine($current)
