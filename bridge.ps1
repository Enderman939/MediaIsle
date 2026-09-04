# =====================================================================
# MediaIsle - SMTC Bridge (PowerShell 5.1)
# 通过 Windows Runtime (System Media Transport Controls) 读取并控制
# 系统中正在播放的媒体（Spotify / 网易云 / Chrome / QQ音乐 等）
#
# 协议:
#   stdout -> 每行一个 JSON: { type: 'ready' | 'state' | 'error', ... }
#             state: { hasSession, appId, source, title, artist, album,
#                      status, position, duration, canPlay, canPause,
#                      canNext, canPrev, canSeek, artHash, art? }
#   命令  <- 主进程向 -CommandFile 指定的文件原子写入(每行一个):
#             { cmd: 'play'|'pause'|'toggle'|'next'|'prev'|'seek',
#               position?: number(秒) }
#
# 兼容性说明（已在 Win11 24H2+ 实测）:
#   - 新版 SMTC: TryGetMediaPropertiesAsync / TryTogglePlayPauseAsync
#               / IsPlaybackPositionEnabled
#   - 旧版 SMTC: GetMediaPropertiesAsync / TryPlayPauseToggleAsync
#               / IsChangePlaybackPositionEnabled
#   - 封面流对象为 __ComObject, PS 无法直接转换, 需反射调用
#     WindowsRuntimeStreamExtensions.AsStreamForRead
# =====================================================================
param(
    [switch]$Once,
    [int]$IntervalMs = 500,
    [string]$CommandFile = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

function Emit($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
}

# ---------------------------------------------------------------- WinRT
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

    $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

    # 等待 IAsyncOperation<T> 完成（带超时，防止个别会话卡死桥接进程）
    function Await($WinRtTask, $ResultType, [int]$TimeoutMs = 4000) {
        $asTask = $script:asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($WinRtTask))
        if (-not $netTask.Wait($TimeoutMs)) { return $null }
        return $netTask.Result
    }

    # 封面流转换（__ComObject -> .NET Stream，必须走反射）
    $script:AsStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod(
        'AsStreamForRead', [type[]]@([Windows.Storage.Streams.IRandomAccessStream]))

    $script:manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    if ($null -eq $script:manager) { throw "RequestAsync 超时" }
}
catch {
    Emit @{ type = 'error'; message = "初始化 SMTC 失败: $($_.Exception.Message)" }
    exit 1
}

# ---------------------------------------------------------- 音量 (Core Audio)
# IAudioEndpointVolume COM 互操作: 读取/设置主音量与静音, 每次循环轮询检测变化
$script:audioOk = $false
try {
    Add-Type -TypeDefinition @'
namespace FastMusicIsland {
  using System;
  using System.Runtime.InteropServices;

  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioEndpointVolume {
    int RegisterControlChangeCallback(IntPtr evContext, IntPtr pNotify);
    int UnregisterControlChangeCallback(IntPtr pNotify);
    int GetChannelCount(out uint pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, IntPtr evContext);
    int SetMasterVolumeLevelScalar(float fLevel, IntPtr evContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, IntPtr evContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, IntPtr evContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, IntPtr evContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
  }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, IntPtr ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  internal class MMDeviceEnumeratorCom { }

  public static class Audio {
    private static IAudioEndpointVolume ep;
    private static IAudioEndpointVolume EP() {
      if (ep == null) {
        var en = (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorCom();
        IMMDevice dev;
        Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
        var iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        object o;
        Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 0x17, IntPtr.Zero, out o));
        ep = (IAudioEndpointVolume)o;
      }
      return ep;
    }
    public static double GetVolume() { float f; EP().GetMasterVolumeLevelScalar(out f); return Math.Round(f * 100.0, 1); }
    public static void SetVolume(double v) { if (v < 0) v = 0; if (v > 100) v = 100; EP().SetMasterVolumeLevelScalar((float)(v / 100.0), IntPtr.Zero); }
    public static bool GetMute() { bool b; EP().GetMute(out b); return b; }
    public static void SetMute(bool m) { EP().SetMute(m, IntPtr.Zero); }
  }

  public static class Fs {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int max);
    public static bool IsFullscreen() {
      var h = GetForegroundWindow(); if (h == IntPtr.Zero) return false;
      // 桌面外壳(Progman/WorkerW)窗口矩形恰好铺满显示器, 会被误判为全屏
      var sb = new System.Text.StringBuilder(256);
      GetClassName(h, sb, 256);
      var cls = sb.ToString();
      if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd") return false;
      RECT r; if (!GetWindowRect(h, out r)) return false;
      var m = MonitorFromWindow(h, 2);
      var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(m, ref mi)) return false;
      return r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B;
    }
  }


    }
  }
}
'@
    $script:audioOk = $true
} catch {
    Emit @{ type = 'error'; message = "音频互操作初始化失败(音量功能禁用): $($_.Exception.Message)" }
}

# ------------------------------------------------------------ helpers
# 乱码修复: 部分曲目元数据被"UTF-8 当 GBK 解码"污染(如 鏉傸綋)。
# 程序化生成完整乱码特征集: 常用 CJK 区(4E00-9FFF) 每个字的 UTF-8 字节
# 被 GBK 误读后的产物。判定三重条件全部满足才修复:
#   1) 原串含 >=2 个特征字
#   2) 逆转换(GBK 编码回字节 -> UTF-8 解码)无替换符且结果不同
#   3) 修复后特征字密度下降, 且含 CJK/假名/谚文/西里尔 可读文字
# 正常中文/俄文/日文标题因不满足条件 2/3 而原样保留。
$utf8Enc = [System.Text.Encoding]::UTF8
$gbkEnc  = [System.Text.Encoding]::GetEncoding(936)
$script:mojiSet = New-Object 'System.Collections.Generic.HashSet[char]'
# 将整个 CJK 区连续拼接后一次性 GBK 误读, 覆盖全部字节对齐方式产生的乱码字
$allCjk = New-Object System.Text.StringBuilder
for ($c = 0x4E00; $c -le 0x9FFF; $c++) { [void]$allCjk.Append([char]$c) }
$artStream = $gbkEnc.GetString($utf8Enc.GetBytes($allCjk.ToString()))
foreach ($ch in $artStream.ToCharArray()) {
    if ($ch -ne [char]0xFFFD) { [void]$script:mojiSet.Add($ch) }
}
function Count-Moji([string]$s) {
    $n = 0
    foreach ($ch in $s.ToCharArray()) { if ($script:mojiSet.Contains($ch)) { $n++ } }
    return $n
}
function Repair-Mojibake([string]$s) {
    if (-not $s -or $s.Length -lt 2) { return $s }
    $m0 = Count-Moji $s
    if ($m0 -lt 2) { return $s }
    try {
        $fixed = [System.Text.Encoding]::UTF8.GetString($gbkEnc.GetBytes($s))
        if ($fixed -eq $s) { return $s }
        # 替换符只允许出现在尾部损伤区(污染时丢失的末字尾字节, 不可恢复):
        # 截断保留干净前缀。开头/中间出现替换符 = 正常标题被误修, 拒绝。
        # 注意: 必须用 Ordinal 比较, 默认文化敏感比较会把 U+FFFD 当可忽略字符(IndexOf 恒为 0)
        $ffChar = [string][char]0xFFFD
        $idx = $fixed.IndexOf($ffChar, [System.StringComparison]::Ordinal)
        if ($idx -ge 0) {
            if ($idx -lt $fixed.Length - 2) { return $s }
            $fixed = $fixed.Substring(0, $idx)
        }
        if (-not $fixed) { return $s }
        if ((Count-Moji $fixed) -ge $m0) { return $s }
        if ($fixed -notmatch '[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0400-\u04FF]') { return $s }
        return $fixed
    } catch { }
    return $s
}

# 多音源: 记忆用户选择的会话(AppUserModelId), 控制与状态均指向所选会话
$script:selectedAppId = $null

function Get-Sessions {
    try { return @($script:manager.GetSessions()) } catch { return @() }
}

function Get-TargetSession {
    if ($script:selectedAppId) {
        foreach ($s in (Get-Sessions)) {
            if ([string]$s.SourceAppUserModelId -eq $script:selectedAppId) { return $s }
        }
        $script:selectedAppId = $null
    }
    return $script:manager.GetCurrentSession()
}

function Get-FriendlySource([string]$aumid) {
    if (-not $aumid) { return '' }
    $s = $aumid
    if ($s.Contains('!')) { $s = $s.Split('!')[-1] }
    $s = $s -replace '\.exe$', ''
    $s = $s -replace '\.WINDOWS\..*$', ''
    $low = $s.ToLower()
    switch -Regex ($low) {
        'spotify'        { return 'Spotify' }
        'chrome'         { return 'Chrome' }
        'msedge|edge'    { return 'Edge' }
        'firefox'        { return 'Firefox' }
        'qqmusic'        { return 'QQ音乐' }
        'cloudmusic'     { return '网易云音乐' }
        'soda|汽水'      { return '汽水音乐' }
        'kugou'          { return '酷狗音乐' }
        'kuwo'           { return '酷我音乐' }
        'potplayer'      { return 'PotPlayer' }
        'vlc'            { return 'VLC' }
        'foobar2000'     { return 'foobar2000' }
        'bilibili|bilibililive' { return '哔哩哔哩' }
        'steam'          { return 'Steam' }
        'wmplayer'       { return 'Windows 播放器' }
        'music'          { return '音乐' }
        default {
            if ($s.Length -gt 0) { return (Get-Culture).TextInfo.ToTitleCase($s) }
            return ''
        }
    }
    return ''
}

# 读取封面缩略图 -> base64 data URL（反射方式，兼容 __ComObject）
$script:md5 = [System.Security.Cryptography.MD5]::Create()
function Read-Art($props) {
    try {
        $thumb = $props.Thumbnail
        if ($null -eq $thumb) { return $null }
        $winrtStream = Await ($thumb.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        if ($null -eq $winrtStream) { return $null }
        $netStream = $script:AsStreamForRead.Invoke($null, @($winrtStream))
        if ($null -eq $netStream) { return $null }
        $ms = New-Object System.IO.MemoryStream
        $netStream.CopyTo($ms)
        $bytes = $ms.ToArray()
        $netStream.Dispose()
        $ms.Dispose()
        if ($null -eq $bytes -or $bytes.Length -eq 0) { return $null }
        $hash = [BitConverter]::ToString($script:md5.ComputeHash($bytes)).Replace('-', '')
        $mime = 'image/jpeg'
        try { if ($winrtStream.ContentType) { $mime = [string]$winrtStream.ContentType } } catch { }
        return @{
            hash = $hash
            data = "data:$mime;base64," + [Convert]::ToBase64String($bytes)
        }
    }
    catch { return $null }
}

# 读取媒体属性（新旧 API 兼容）
function Get-MediaProps($session) {
    $mpType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
    try { return Await ($session.TryGetMediaPropertiesAsync()) ($mpType) }
    catch {
        try { return Await ($session.GetMediaPropertiesAsync()) ($mpType) }
        catch { return $null }
    }
}

# 封面缓存（按 会话+歌曲 键，避免每次轮询重复读取缩略图）
$script:lastArtKey  = $null
$script:lastArtHash = 'none'
$script:lastArtData = $null

function Get-State {
    $session = Get-TargetSession
    if ($null -eq $session) {
        $script:lastArtKey  = $null
        $script:lastArtHash = 'none'
        $script:lastArtData = $null
        return @{ type = 'state'; hasSession = $false; sources = @(); selApp = '' }
    }

    $appId = [string]$session.SourceAppUserModelId
    $props = Get-MediaProps $session
    if ($null -eq $props) { return @{ type = 'state'; hasSession = $false } }

    $info = $session.GetPlaybackInfo()
    $tl   = $session.GetTimelineProperties()

    $status = 'Unknown'
    $canPlay = $false; $canPause = $false; $canNext = $false; $canPrev = $false; $canSeek = $false
    $canShuffle = $false; $canRepeat = $false
    $isShuffle = $false; $repeatMode = 0
    if ($null -ne $info) {
        try { $status = [string]$info.PlaybackStatus } catch { }
        try { $isShuffle   = [bool]$info.IsShuffleActive } catch { }
        try { $repeatMode  = [int]$info.AutoRepeatMode } catch { }
        $ctl = $info.Controls
        if ($null -ne $ctl) {
            try { $canPlay  = [bool]$ctl.IsPlayEnabled } catch { }
            try { $canPause = [bool]$ctl.IsPauseEnabled } catch { }
            try { $canNext  = [bool]$ctl.IsNextEnabled } catch { }
            try { $canPrev  = [bool]$ctl.IsPreviousEnabled } catch { }
            try { $canSeek  = [bool]$ctl.IsPlaybackPositionEnabled } catch { }
            if (-not $canSeek) { try { $canSeek = [bool]$ctl.IsChangePlaybackPositionEnabled } catch { } }
            try { $canShuffle  = [bool]$ctl.IsShuffleEnabled } catch { }
            try { $canRepeat   = [bool]$ctl.IsRepeatEnabled } catch { }
        }
    }

    $position = 0.0; $duration = 0.0; $posAge = 0.0
    if ($null -ne $tl) {
        try { if ($tl.Position) { $position = $tl.Position.TotalSeconds } } catch { }
        try { if ($tl.EndTime)  { $duration  = $tl.EndTime.TotalSeconds } } catch { }
        # 时间轴年龄: Position 是多久之前采样的(供前端做歌词同步补偿)
        try {
            if ($tl.LastUpdatedTime) {
                $posAge = [math]::Max(0, [double](([System.DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds))
                if ($posAge -gt 30) { $posAge = 30 }
            }
        } catch { }
    }

    $title  = Repair-Mojibake ([string]$props.Title)
    $artist = Repair-Mojibake ([string]$props.Artist)
    $album  = Repair-Mojibake ([string]$props.AlbumName)

    # 封面仅在该会话歌曲变化时重新读取
    $artKey = "$appId|$title|$artist"
    $freshArt = $false
    if ($artKey -ne $script:lastArtKey) {
        $script:lastArtKey = $artKey
        $read = Read-Art $props
        if ($read) {
            $script:lastArtHash = $read.hash
            $script:lastArtData = $read.data
        }
        else {
            $script:lastArtHash = 'none'
            $script:lastArtData = $null
        }
        $freshArt = $true
    }

    $state = @{
        type       = 'state'
        hasSession = $true
        appId      = $appId
        source     = Get-FriendlySource $appId
        title      = $title
        artist     = $artist
        album      = $album
        status     = $status
        position   = [math]::Round($position, 3)
        duration   = [math]::Round($duration, 3)
        posAge     = [math]::Round($posAge, 3)
        canPlay    = $canPlay
        canPause   = $canPause
        canNext    = $canNext
        canPrev    = $canPrev
        canSeek    = $canSeek
        canShuffle = $canShuffle
        canRepeat  = $canRepeat
        isShuffle  = $isShuffle
        repeatMode = $repeatMode
        selApp     = if ($script:selectedAppId) { $script:selectedAppId } else { $appId }
        artHash    = $script:lastArtHash
    }
    # 可用音源列表(按 AppUserModelId 去重)
    $sources = @(); $seen = @{}
    foreach ($s in (Get-Sessions)) {
        $id = [string]$s.SourceAppUserModelId
        if (-not $id -or $seen.ContainsKey($id)) { continue }
        $seen[$id] = 1
        $sources += @{ id = $id; name = (Get-FriendlySource $id) }
    }
    $state.sources = $sources
    # 只在封面变化的那一帧附带 art 数据，主进程负责缓存
    if ($freshArt -and $script:lastArtData) { $state.art = $script:lastArtData }
    return $state
}

function Invoke-Command($cmdObj) {
    $session = Get-TargetSession
    if ($null -eq $session) { return }
    switch ([string]$cmdObj.cmd) {
        'switch-source' {
            $id = [string]$cmdObj.appId
            if (-not $id) { return }
            foreach ($s in (Get-Sessions)) {
                if ([string]$s.SourceAppUserModelId -eq $id) { $script:selectedAppId = $id; break }
            }
        }
        'play'   { $null = Await ($session.TryPlayAsync()) ([bool]) }
        'pause'  { $null = Await ($session.TryPauseAsync()) ([bool]) }
        'toggle' {
            try { $null = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
            catch { $null = Await ($session.TryPlayPauseToggleAsync()) ([bool]) }
        }
        'next'   { $null = Await ($session.TrySkipNextAsync()) ([bool]) }
        'prev'   { $null = Await ($session.TrySkipPreviousAsync()) ([bool]) }
        'seek'   {
            $sec = 0.0
            if (-not [double]::TryParse([string]$cmdObj.position, [System.Globalization.NumberStyles]::Float,
                    [System.Globalization.CultureInfo]::InvariantCulture, [ref]$sec)) { return }
            $ticks = [Int64]([math]::Round($sec * 10000000))
            if ($ticks -lt 0) { $ticks = 0 }
            $null = Await ($session.TryChangePlaybackPositionAsync($ticks)) ([bool])
        }
        'shuffle' {
            try {
                $cur = $false
                try { $cur = [bool]$session.GetPlaybackInfo().IsShuffleActive } catch { }
                $null = Await ($session.TryChangeShuffleActiveAsync(!$cur)) ([bool]) 2000
            } catch { Emit @{ type = 'error'; message = "切换随机播放失败: $($_.Exception.Message)" } }
        }
        'volume' {
            if (-not $script:audioOk) { return }
            try {
                $pct = 0.0
                if (-not [double]::TryParse([string]$cmdObj.position, [System.Globalization.NumberStyles]::Float,
                        [System.Globalization.CultureInfo]::InvariantCulture, [ref]$pct)) { return }
                if ($pct -lt 0) { $pct = 0 }
                if ($pct -gt 100) { $pct = 100 }
                [FastMusicIsland.Audio]::SetVolume($pct)
            } catch { Emit @{ type = 'error'; message = "设置音量失败: $($_.Exception.Message)" } }
        }
        'toggle-mute' {
            if (-not $script:audioOk) { return }
            try { [FastMusicIsland.Audio]::SetMute(-not [FastMusicIsland.Audio]::GetMute()) }
            catch { Emit @{ type = 'error'; message = "切换静音失败: $($_.Exception.Message)" } }
        }
        'repeat' {
            try {
                $cur = 0
                try { $cur = [int]$session.GetPlaybackInfo().AutoRepeatMode } catch { }
                $next = ($cur + 1) % 3
                $null = Await ($session.TryChangeAutoRepeatModeAsync([Windows.Media.Control.RepeatMode]$next)) ([bool]) 2000
            } catch { Emit @{ type = 'error'; message = "切换循环模式失败: $($_.Exception.Message)" } }
        }
    }
}

# ---------------------------------------------------------------- main
Emit @{ type = 'ready' }

# 一次性模式：输出一帧状态后退出（用于测试）
if ($Once) {
    try { Emit (Get-State) }
    catch { Emit @{ type = 'error'; message = "状态读取失败: $($_.Exception.Message)" } }
    exit 0
}

# 命令通道: 主进程向 $CommandFile 原子写入 JSON 命令(每行一个), 此处轮询消费
# (PS 5.1 的 stdin 读取会阻塞主循环, 故弃用管道)
$lastPoll = [DateTime]::MinValue
$forcePoll = $true
$script:lastVol = $null
$script:lastMute = $null
$script:lastFs = $null

while ($true) {
    # 1. 消费命令文件
    if ($CommandFile -and (Test-Path -LiteralPath $CommandFile)) {
        $raw = $null
        try { $raw = [System.IO.File]::ReadAllText($CommandFile) } catch { }
        try { Remove-Item -LiteralPath $CommandFile -Force -ErrorAction SilentlyContinue } catch { }
        if ($raw) {
            foreach ($ln in ($raw -split "`n")) {
                $txt = "$ln".Trim()
                if ($txt.Length -gt 0) {
                    try {
                        Invoke-Command ($txt | ConvertFrom-Json)
                        $forcePoll = $true
                    }
                    catch {
                        Emit @{ type = 'error'; message = "命令执行失败: $($_.Exception.Message)" }
                    }
                }
            }
        }
    }

    # 2. 音量变化检测 (键盘音量键约 120ms 内被捕获)
    if ($script:audioOk) {
        try {
            $vol = [FastMusicIsland.Audio]::GetVolume()
            $mute = [FastMusicIsland.Audio]::GetMute()
            if ($vol -ne $script:lastVol -or $mute -ne $script:lastMute) {
                $script:lastVol = $vol
                $script:lastMute = $mute
                Emit @{ type = 'volume'; volume = $vol; mute = [bool]$mute }
            }
        } catch { }
    }

    # 3. 全屏前台检测 (游戏/视频全屏时通知主进程隐藏岛体)
    try {
        $fs = [FastMusicIsland.Fs]::IsFullscreen()
        if ($fs -ne $script:lastFs) {
            $script:lastFs = $fs
            Emit @{ type = 'fs'; v = [bool]$fs }
        }
    } catch { }

    # 4. 轮询媒体状态
    $now = Get-Date
    if ($forcePoll -or (($now - $lastPoll).TotalMilliseconds -ge $IntervalMs)) {
        $lastPoll = $now
        $forcePoll = $false
        try { Emit (Get-State) }
        catch { Emit @{ type = 'error'; message = "状态读取失败: $($_.Exception.Message)" } }
    }

    Start-Sleep -Milliseconds 120
}
