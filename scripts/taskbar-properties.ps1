param([long]$WindowHandle, [int]$TargetProcessId)
if ($TargetProcessId) { $WindowHandle = (Get-Process -Id $TargetProcessId).MainWindowHandle.ToInt64() }
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TaskbarProperties {
  [StructLayout(LayoutKind.Sequential, Pack=4)] public struct Key { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size=24)] public struct Value { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr text; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Store {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out Key key);
    [PreserveSig] int GetValue(ref Key key, out Value value);
    [PreserveSig] int SetValue(ref Key key, ref Value value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, out Store store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref Value value);
  public static Dictionary<string,string> Read(long handle) {
    Guid iid = typeof(Store).GUID; Store store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(new IntPtr(handle), ref iid, out store));
    var result = new Dictionary<string,string>();
    try {
      uint count; Marshal.ThrowExceptionForHR(store.GetCount(out count));
      for (uint i=0;i<count;i++) {
        Key key; Value value; Marshal.ThrowExceptionForHR(store.GetAt(i,out key)); Marshal.ThrowExceptionForHR(store.GetValue(ref key,out value));
        try { if (value.type==31) result[key.fmtid+":"+key.pid]=Marshal.PtrToStringUni(value.text); }
        finally { PropVariantClear(ref value); }
      }
    } finally { Marshal.ReleaseComObject(store); }
    return result;
  }
}
'@
[TaskbarProperties]::Read($WindowHandle) | ConvertTo-Json -Compress
