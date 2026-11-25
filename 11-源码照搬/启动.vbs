' 启动.vbs —— 启动「XIODRA 工作台」
' 编码约定：本文件必须是 ANSI(GBK) 无 BOM，VBScript 按 ANSI 读取。
'
' 所有可调参数（端口 / 目录 / 电子程序位置 / 窗口样式 / 要清掉的环境变量）
' 都在工作台根目录的 config.json 里，本脚本只负责读出来再启动，不再写死任何值。
Option Explicit
Dim fso, sh, ts, lib, root, port, shellDir, engineDir, engineData, electron, args, style, env2

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)

' ---- 读公用配置库（读 config.json 的解析器，两个启动器共用一份）----
If Not fso.FileExists(root & "\工具\启动配置.vbs") Then
  MsgBox "缺少 工具\启动配置.vbs（它负责读 config.json）" & vbCrLf & root, 48, "XIODRA 工作台"
  WScript.Quit 1
End If
Set ts = fso.OpenTextFile(root & "\工具\启动配置.vbs", 1, False, 0)
lib = ts.ReadAll
ts.Close
ExecuteGlobal lib

If Not CfgLoad(root) Then
  MsgBox "没找到或读不了 config.json" & vbCrLf & root & "\config.json", 48, "XIODRA 工作台"
  WScript.Quit 1
End If

' ---- 从配置里取参数（缺项用兜底值，脚本永远能跑起来）----
port = CfgNum("port", 33083)
shellDir = CfgPath("shellDir", root & "\外壳")
engineDir = CfgPath("engineDir", root & "\引擎")
engineData = CfgPath("engineDataDir", root & "\引擎数据\.dsh")
electron = CfgPath("electronExe", shellDir & "\node_modules\electron\dist\electron.exe")
args = CfgStr("electronArgs", ".")
style = CfgNum("windowStyle", 1)

If Not fso.FolderExists(engineData) Then fso.CreateFolder engineData

Set env2 = sh.Environment("PROCESS")
' 父进程若残留 ELECTRON_RUN_AS_NODE=1，electron.exe 会退化成纯 Node 直接报错退出
env2.Remove CfgStr("clearEnv", "ELECTRON_RUN_AS_NODE")
env2("DSH_PORT") = CStr(CLng(port))
env2("DSH_CUSTOMER_HOME") = engineData
env2("DSH_SHELL_DIR") = shellDir
env2("DSH_ENGINE_DIR") = engineDir

If fso.FileExists(electron) Then
  sh.CurrentDirectory = shellDir
  ' 第二参数 = 窗口样式（1 正常窗口；写 0 会把 Electron 主窗口一起隐藏，极难排查）
  sh.Run """" & electron & """ " & args, CInt(style), False
Else
  MsgBox "还没装依赖：先在 外壳 目录里运行 npm install" & vbCrLf & shellDir, 48, "XIODRA 工作台"
End If
