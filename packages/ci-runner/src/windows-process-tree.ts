/**
 * taskkill /T snapshots descendants before terminating their parents. npm can
 * create a cmd -> node descendant after that snapshot. Stop parents first, hold
 * their process handles (preventing PID reuse), then discover and stop children.
 * The helper runs as the caller, uses only OS/.NET facilities, and emits no data.
 */
export function windowsTerminationCommand(
  processId: number,
  earliestStart: number,
  latestStart: number,
): string {
  if (
    ![processId, earliestStart, latestStart].every(Number.isSafeInteger) ||
    processId <= 0
  ) {
    throw new TypeError('process termination identity is invalid');
  }
  return `
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddMilliseconds(4000)
# Use native snapshots: WMI/CIM cold startup exceeds the local timeout contract.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ReleaseDeckProcessSnapshot {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Entry {
    public uint size, usage, pid;
    public UIntPtr heap;
    public uint module, threads, parent;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int[] Children(int parent) {
    var result = new List<int>();
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new Win32Exception();
    try {
      var entry = new Entry();
      entry.size = (uint)Marshal.SizeOf(entry);
      if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception();
      do {
        if (entry.parent == parent) result.Add((int)entry.pid);
      } while (Process32NextW(snapshot, ref entry));
      if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception();
      return result.ToArray();
    } finally { CloseHandle(snapshot); }
  }
}
'@
function Remaining {
  $left = [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
  if ($left -le 0) { throw 'termination deadline exceeded' }
  return $left
}
function Children($parent, $started, $children) {
  $null = Remaining
  foreach ($childId in [ReleaseDeckProcessSnapshot]::Children($parent.Id)) {
    if ($children.ContainsKey($childId)) { continue }
    try { $child = [Diagnostics.Process]::GetProcessById($childId) }
    catch [ArgumentException] { continue }
    $retained = $false
    try {
      $null = $child.Handle
      # Recheck parentage after pinning the child PID, excluding recycled IDs.
      if ($child.StartTime.ToUniversalTime() -lt $started) { continue }
      if ([ReleaseDeckProcessSnapshot]::Children($parent.Id) -notcontains $childId) { continue }
      $children.Add($childId, $child)
      $retained = $true
    } finally { if (-not $retained) { $child.Dispose() } }
  }
}
function StopTree($process) {
  $children = @{}
  try {
    $started = $process.StartTime.ToUniversalTime()
    Children $process $started $children
    if (-not $process.HasExited) { $process.Kill() }
    if (-not $process.WaitForExit((Remaining))) { throw 'process did not exit' }
    # Once the parent is dead it cannot create any more direct children.
    Children $process $started $children
    foreach ($child in @($children.Values)) { StopTree $child }
  } finally {
    foreach ($child in @($children.Values)) { $child.Dispose() }
  }
}
try {
  $root = [Diagnostics.Process]::GetProcessById(${processId})
  try {
    $null = $root.Handle
    $started = [DateTimeOffset]$root.StartTime.ToUniversalTime()
    if ($started.ToUnixTimeMilliseconds() -lt ${earliestStart} -or $started.ToUnixTimeMilliseconds() -gt ${latestStart}) {
      throw 'root process identity changed'
    }
    StopTree $root
  } finally { $root.Dispose() }
  exit 0
} catch { exit 1 }
`;
}
