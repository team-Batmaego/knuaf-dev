// One kernel listing (NtQuerySystemInformation) carries PID, parent PID, image name AND
// creation time for every process — including other accounts' — so no row is left without
// a birth time and no per-process handle is needed for identity.
export const NATIVE_PROCESSES = String.raw`
namespace KnuafUpdate {
 using System;
 using System.Text;
 using System.Collections.Generic;
 using System.ComponentModel;
 using System.Runtime.InteropServices;
 public static class ProcessSnapshot {
  [StructLayout(LayoutKind.Sequential)] struct Time { public uint low,high; public long Value { get { return ((long)high<<32)|low; } } }
  public sealed class Row { public int pid,parent; public string created,name,path; }
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind,IntPtr buffer,int length,out int needed);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out Time creation,out Time exit,out Time kernel,out Time user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static List<Row> Read(int collector) {
   // One kernel listing carries PID, parent PID, image name AND creation time for every
   // process, including other accounts' — no per-process handle is needed for identity.
   if(IntPtr.Size!=8) throw new PlatformNotSupportedException("64-bit process listing only");
   var rows=new List<Row>(); int size=1<<20; IntPtr buffer=IntPtr.Zero;
   try {
    int total=0;
    for(int attempt=1;;attempt++) {
     int needed; buffer=Marshal.AllocHGlobal(size);
     int status=NtQuerySystemInformation(5,buffer,size,out needed);
     if(status==0) { total=needed; break; }
     Marshal.FreeHGlobal(buffer); buffer=IntPtr.Zero;
     if(status!=unchecked((int)0xC0000004) || attempt>=8) throw new Win32Exception("NtQuerySystemInformation 0x"+status.ToString("x8"));
     size=Math.Max(size*2,needed+65536);
    }
    // Only the bytes the kernel reported are a listing; every row and name must lie inside them.
    if(total<104 || total>size) throw new InvalidOperationException("process listing is malformed");
    long start=buffer.ToInt64(), offset=0;
    for(;;) {
     if(offset+104>total) throw new InvalidOperationException("process listing is malformed");
     IntPtr entry=new IntPtr(start+offset);
     int next=Marshal.ReadInt32(entry,0);
     if(next<0 || (next!=0 && next<104) || offset+next>total) throw new InvalidOperationException("process listing is malformed");
     long born=Marshal.ReadInt64(entry,32);
     int length=(ushort)Marshal.ReadInt16(entry,56); long text=Marshal.ReadIntPtr(entry,64).ToInt64();
     if((length&1)!=0 || (length>0 && (text<start || text+length>start+total))) throw new InvalidOperationException("process listing is malformed");
     long pid=Marshal.ReadIntPtr(entry,80).ToInt64(), parent=Marshal.ReadIntPtr(entry,88).ToInt64();
     if(pid<0 || pid>Int32.MaxValue || parent<0 || parent>Int32.MaxValue) throw new InvalidOperationException("process listing is malformed");
     if(pid!=0) {
      var row=new Row{pid=(int)pid,parent=(int)parent,name=length==0?"":Marshal.PtrToStringUni(new IntPtr(text),length/2),created=born>0?DateTime.FromFileTimeUtc(born).ToString("o"):"",path=null};
      var process=OpenProcess(0x1000,false,(uint)pid);
      if(process!=IntPtr.Zero) try {
       Time created,exited,kernel,user;
       // The handle may belong to a later process that reused this PID. Its path is this
       // row's path only when the birth time is the listing's; otherwise the path stays unread.
       if(GetProcessTimes(process,out created,out exited,out kernel,out user) && created.Value==born) {
        uint chars=32768; var path=new StringBuilder((int)chars);
        if(QueryFullProcessImageName(process,0,path,ref chars)) row.path=global::UpdateNativePath.Expand(path.ToString());
       }
      } finally { CloseHandle(process); }
      rows.Add(row);
     }
     if(next==0) break;
     offset+=next;
    }
   } finally { if(buffer!=IntPtr.Zero) Marshal.FreeHGlobal(buffer); }
   // The trusted collector (including any compiler/console children) is maintenance,
   // not a provider to be stopped. No unrelated/app child is excluded by executable name.
   var identities=new Dictionary<int,Row>(); foreach(var row in rows) identities[row.pid]=row;
   var maintenance=new HashSet<int>(); maintenance.Add(collector); bool changed=true;
   while(changed) {
    changed=false;
    foreach(var row in rows) {
     Row parent;
     if(maintenance.Contains(row.parent) && identities.TryGetValue(row.parent,out parent) &&
        row.created!="" && parent.created!="" && String.CompareOrdinal(parent.created,row.created)<=0 && maintenance.Add(row.pid)) changed=true;
    }
   }
   rows.RemoveAll(row=>maintenance.Contains(row.pid)); return rows;
  }
 }
}
`
