' ============================================================================
' lib-启动配置.vbs —— 读工作台根目录的 config.json，给两个启动器共用
' 编码约定：本文件与引用它的脚本都必须是 ANSI(GBK) 无 BOM。
' 用法（在启动脚本里）：
'   ExecuteGlobal 本文件全文
'   If Not CfgLoad(scriptDir) Then MsgBox "..." : WScript.Quit 1
'   port = CfgNum("port", 33083)
'   dataDir = CfgPath("engineDataDir", "")
' 说明：只实现"读"这一件事，而且只覆盖本项目 config.json 用到的写法
'       （对象 + 字符串 + 数字 + true/false/null）。数组整段跳过，注释 // 跳过。
'       嵌套键用点号取，例如 CfgStr("window.width", 1380)。
' ============================================================================

Dim g_cfgMap      ' Scripting.Dictionary：扁平键 -> 文本值
Dim g_cfgPath     ' 实际读到的 config.json 绝对路径（没读到就是空串）
Dim g_cfgTxt, g_cfgPos, g_cfgLen

' 读 UTF-8 文件（VBScript 原生只认 ANSI，必须借 ADODB.Stream 指定 charset）
Function CfgReadUtf8(filePath)
  Dim st
  CfgReadUtf8 = ""
  On Error Resume Next
  Set st = CreateObject("ADODB.Stream")
  If Err.Number <> 0 Then Err.Clear : Exit Function
  st.Type = 2
  st.Charset = "utf-8"
  st.Open
  st.LoadFromFile filePath
  If Err.Number = 0 Then CfgReadUtf8 = st.ReadText
  st.Close
  On Error GoTo 0
End Function

Sub CfgSkipWs()
  Dim c
  Do While g_cfgPos <= g_cfgLen
    c = Mid(g_cfgTxt, g_cfgPos, 1)
    If c = " " Or c = vbTab Or c = vbCr Or c = vbLf Then
      g_cfgPos = g_cfgPos + 1
    ElseIf c = "/" And Mid(g_cfgTxt, g_cfgPos + 1, 1) = "/" Then
      Do While g_cfgPos <= g_cfgLen
        If Mid(g_cfgTxt, g_cfgPos, 1) = vbLf Then Exit Do
        g_cfgPos = g_cfgPos + 1
      Loop
    Else
      Exit Do
    End If
  Loop
End Sub

' 当前位置必须是双引号：读出一个字符串并前移
Function CfgReadString()
  Dim out, c, n
  out = ""
  g_cfgPos = g_cfgPos + 1
  Do While g_cfgPos <= g_cfgLen
    c = Mid(g_cfgTxt, g_cfgPos, 1)
    If c = """" Then
      g_cfgPos = g_cfgPos + 1
      Exit Do
    End If
    If c = "\" Then
      n = Mid(g_cfgTxt, g_cfgPos + 1, 1)
      Select Case n
        Case "n" : out = out & vbLf
        Case "t" : out = out & vbTab
        Case "r" : out = out & vbCr
        Case "b" : out = out & Chr(8)
        Case "f" : out = out & Chr(12)
        Case "u"
          out = out & ChrW(CInt("&H" & Mid(g_cfgTxt, g_cfgPos + 2, 4)))
          g_cfgPos = g_cfgPos + 4
        Case Else : out = out & n
      End Select
      g_cfgPos = g_cfgPos + 2
    Else
      out = out & c
      g_cfgPos = g_cfgPos + 1
    End If
  Loop
  CfgReadString = out
End Function

' 读一个标量（数字 / true / false / null）的原文
Function CfgScalarText()
  Dim s, c
  s = ""
  Do While g_cfgPos <= g_cfgLen
    c = Mid(g_cfgTxt, g_cfgPos, 1)
    If c = "," Or c = "}" Or c = "]" Or c = vbCr Or c = vbLf Or c = " " Or c = vbTab Then Exit Do
    s = s & c
    g_cfgPos = g_cfgPos + 1
  Loop
  CfgScalarText = s
End Function

' 跳过任意值（本期不需要数组，整段丢掉即可）
Sub CfgSkipValue()
  Dim c, depth
  CfgSkipWs
  c = Mid(g_cfgTxt, g_cfgPos, 1)
  If c = """" Then
    CfgReadString
    Exit Sub
  End If
  If c = "{" Or c = "[" Then
    depth = 0
    Do While g_cfgPos <= g_cfgLen
      c = Mid(g_cfgTxt, g_cfgPos, 1)
      If c = """" Then
        CfgReadString
      Else
        If c = "{" Or c = "[" Then
          depth = depth + 1
          g_cfgPos = g_cfgPos + 1
        ElseIf c = "}" Or c = "]" Then
          depth = depth - 1
          g_cfgPos = g_cfgPos + 1
          If depth <= 0 Then Exit Sub
        Else
          g_cfgPos = g_cfgPos + 1
        End If
      End If
    Loop
    Exit Sub
  End If
  CfgScalarText
End Sub

' 把一个对象里的所有标量摊平成"父.子"键存进 g_cfgMap
Sub CfgParseObj(prefix)
  Dim key, c, raw, vkey
  g_cfgPos = g_cfgPos + 1     ' 跳过 {
  Do
    CfgSkipWs
    c = Mid(g_cfgTxt, g_cfgPos, 1)
    If c = "" Then Exit Do
    If c = "}" Then g_cfgPos = g_cfgPos + 1 : Exit Do
    If c = "," Then g_cfgPos = g_cfgPos + 1
    CfgSkipWs
    If Mid(g_cfgTxt, g_cfgPos, 1) <> """" Then Exit Do   ' 结构坏了就收工，别死循环
    key = CfgReadString()
    CfgSkipWs
    If Mid(g_cfgTxt, g_cfgPos, 1) = ":" Then g_cfgPos = g_cfgPos + 1
    CfgSkipWs
    vkey = key
    If Len(prefix) > 0 Then vkey = prefix & "." & key
    c = Mid(g_cfgTxt, g_cfgPos, 1)
    If c = "{" Then
      CfgParseObj vkey
    ElseIf c = "[" Then
      CfgSkipValue
    ElseIf c = """" Then
      g_cfgMap(vkey) = CfgReadString()
    Else
      raw = CfgScalarText()
      If LCase(raw) = "true" Then
        g_cfgMap(vkey) = "1"
      ElseIf LCase(raw) = "false" Then
        g_cfgMap(vkey) = "0"
      ElseIf LCase(raw) = "null" Then
        g_cfgMap(vkey) = ""
      Else
        g_cfgMap(vkey) = raw
      End If
    End If
  Loop
End Sub

' 从脚本所在目录往上找 config.json（脚本在根目录、在 外壳\ 里都能找到）
Function CfgLoad(scriptDir)
  Dim fso, cands, i, hit
  CfgLoad = False
  Set g_cfgMap = CreateObject("Scripting.Dictionary")
  g_cfgMap.CompareMode = 1     ' 键不分大小写
  g_cfgPath = ""
  Set fso = CreateObject("Scripting.FileSystemObject")
  cands = Array( _
    scriptDir & "\config.json", _
    fso.GetParentFolderName(scriptDir) & "\config.json", _
    fso.GetParentFolderName(fso.GetParentFolderName(scriptDir)) & "\config.json")
  hit = ""
  For i = 0 To UBound(cands)
    If Len(hit) = 0 Then
      If fso.FileExists(cands(i)) Then hit = cands(i)
    End If
  Next
  If Len(hit) = 0 Then Exit Function
  g_cfgPath = hit
  g_cfgTxt = CfgReadUtf8(hit)
  If Len(g_cfgTxt) = 0 Then Exit Function
  ' 去掉可能的 BOM
  If Left(g_cfgTxt, 1) = ChrW(65279) Then g_cfgTxt = Mid(g_cfgTxt, 2)
  g_cfgPos = 1
  g_cfgLen = Len(g_cfgTxt)
  CfgSkipWs
  If Mid(g_cfgTxt, g_cfgPos, 1) = "{" Then CfgParseObj ""
  CfgLoad = True
End Function

Function CfgFile()
  CfgFile = g_cfgPath
End Function

' 取字符串；没这项就返回 def
Function CfgStr(key, def)
  If g_cfgMap Is Nothing Then CfgStr = def : Exit Function
  If g_cfgMap.Exists(key) Then
    CfgStr = g_cfgMap(key)
  Else
    CfgStr = def
  End If
End Function

' 取数字；没这项或不是数字就返回 def
Function CfgNum(key, def)
  Dim v
  CfgNum = def
  If g_cfgMap Is Nothing Then Exit Function
  If Not g_cfgMap.Exists(key) Then Exit Function
  v = Trim(g_cfgMap(key))
  If Len(v) = 0 Then Exit Function
  If IsNumeric(v) Then CfgNum = CDbl(v)
End Function

' 取路径：配置里写成相对路径就按"工作台根目录"补全，绝对路径原样返回
Function CfgPath(key, def)
  Dim raw, root
  raw = CfgStr(key, "")
  If Len(raw) = 0 Then
    CfgPath = def
    Exit Function
  End If
  root = CfgRoot()
  If Mid(raw, 2, 1) = ":" Then          ' C:\... 这种已经绝对
    CfgPath = raw
  ElseIf Left(raw, 2) = "\\" Then       ' UNC
    CfgPath = raw
  ElseIf Left(raw, 1) = "\" Then        ' \外壳 这种按根目录拼
    CfgPath = root & raw
  Else
    CfgPath = root & "\" & raw
  End If
End Function

' 工作台根目录 = config.json 所在目录
Function CfgRoot()
  Dim fso
  If Len(g_cfgPath) = 0 Then
    CfgRoot = ""
    Exit Function
  End If
  Set fso = CreateObject("Scripting.FileSystemObject")
  CfgRoot = fso.GetParentFolderName(g_cfgPath)
End Function
