' start.vbs - 启动 XIODRA 工作台外壳（纯 JS 壳）
' 编码约定：本文件必须是 ANSI(GBK) 无 BOM —— VBScript 按 ANSI 读取，存成 UTF-8 会把中文路径读成乱码。
'
' 参数全部从工作台根目录的 config.json 读（与根目录的 启动.vbs 共用一套配置），
' 本脚本只负责取出来再启动 electron，不再写死端口 / 路径。
Option Explicit
Dim fso, sh, ts, lib, shellDir, root, port, engineDir, engineData, electron, args, style, env2

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
' 外壳目录 = 本脚本所在目录（换盘符/换电脑都不用改）
shellDir = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(shellDir)

' ---- 读公用配置库 ----
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
engineDir = CfgPath("engineDir", root & "\引擎")
engineData = CfgPath("engineDataDir", root & "\引擎数据\.dsh")
electron = CfgPath("electronExe", shellDir & "\node_modules\electron\dist\electron.exe")
args = CfgStr("electronArgs", ".")
style = CfgNum("windowStyle", 1)

sh.CurrentDirectory = shellDir

Set env2 = sh.Environment("PROCESS")
' 关键：Electron 必须以「应用模式」运行。父进程若残留 ELECTRON_RUN_AS_NODE=1，
' electron.exe 会退化成纯 Node，第一句 app API 就报错退出。
env2.Remove CfgStr("clearEnv", "ELECTRON_RUN_AS_NODE")
env2("DSH_PORT") = CStr(CLng(port))
env2("DSH_CUSTOMER_HOME") = engineData
env2("DSH_SHELL_DIR") = shellDir
env2("DSH_ENGINE_DIR") = engineDir

If Not fso.FileExists(electron) Then
  MsgBox "还没装依赖：先在 外壳 目录里运行 npm install" & vbCrLf & shellDir, 48, "XIODRA 工作台"
  WScript.Quit 1
End If

' 第二个参数必须是 1（正常窗口）。写 0 会把 Electron 主窗口一起隐藏掉 —— 进程在跑、
' 引擎也起得来，但用户看不到任何界面，极难排查。False = 不等待退出。
sh.Run """" & electron & """ " & args, CInt(style), False
