# Vocal Tuner — 技术文档与开发指南

本文档全面梳理了 Vocal Tuner 项目的架构设计、技术栈选型、核心算法流程以及各模块的作用，旨在为后续开发者提供详尽的接手指南与优化方向。

---

## 1. 核心架构设计

项目采用 **Python 后端 + 原生 HTML/JS/Canvas 前端** 的经典前后端分离架构，通过 **WebSocket** 实现高频低延迟的单向数据流（后端 → 前端），通过 **REST API** 实现状态控制（前端 → 后端）。

### 1.1 数据流向与执行模型

```mermaid
graph TD
    A[麦克风输入 (SoundDevice)] -->|独立线程音频流 (44100Hz/Mono)| B[缓冲区 Buffer]
    B -->|满 2048 帧| C[asyncio.Queue]
    C -->|消费帧| D[FastAPI: 线程池中执行 pYIN]
    D -->|频率,置信度,voiced| E[FastAPI: 音乐理论转换 (音分/音名)]
    D -.->|每隔 N 帧| F[FastAPI: scipy.FFT]
    D & E & F --> G{JSON 打包}
    G -->|WebSocket (~21fps)| H[前端: ws-client.js 下发]
    H --> I[可视化: 指针调音表]
    H --> J[可视化: 音高历史时间轴]
    H --> K[可视化: 钢琴键盘]
    H --> L[可视化: FFT 频谱]
```

### 1.2 关键性能权衡

1. **音频捕获与事件循环隔离**：`sounddevice` 的回调函数在独立的纯 C/Python 系统线程中运行，直接调用 `FastAPI` 的异步代码会导致死锁或内存泄漏。为此引入 `asyncio.Queue` 与静态的线程安全方法 `call_soon_threadsafe` 进行桥接。
2. **音高检测（算法级）在线程池执行**：pYIN 算法尽管优于传统算法但也属于 CPU 密集型任务，计算 2048 帧数据大约需要 `10-20 ms`。如果直接在 FastAPI 主事件循环中计算，会阻塞 WebSocket 的数据发送，因此使用 `asyncio.to_thread` 将其调度到后台线程池执行。
3. **前端渲染自适应与去抖动**：频繁更新 DOM 可能引发回流导致卡顿，因此所有可视化均由 `Canvas 2D API` + `requestAnimationFrame` 自主接管，与后端通过 WebSocket 接受数据的频率解耦。

---

## 2. 工具链与技术选型

### 后端核心栈

1. **Python 3.11** 及其生态
2. **FastAPI (0.134.0)**：负责提供高并发的 WebSocket 长连接和标准的 REST 接口，配合 Uvicorn ASGI 服务器。
3. **sounddevice**：依赖于 `PortAudio` 库的强大音频输入输出封装，通过流式访问（`blocksize / callback`）截取操作系统的 PCM 音频流。
4. **librosa (0.11)**：事实上的音频分析金标准。项目使用的是 `pYIN（概率 YIN）` 算法，专为人声、单声道的连续单音高估计而生。
5. **NumPy + SciPy**：处理底层向量以及执行快速傅里叶变换（`FFT`）。

### 前端核心栈

1. **原生 HTML + CSS Variables + ES Modules**：考虑到这是一个“单页应用仪表盘”，没有使用如 React 或 Vue 的大型框架，完全采用原生模块化文件（`<script type="module">`）。
2. **原生 Canvas 2D API**：实现 60FPS 流畅的指针、横向滚动的 30s 坐标图及瀑布线图。

---

## 3. 核心算法流程：pYIN 检测

整个应用的核心在 `backend/pitch/detector.py`。其音高检测完整工作流如下：

### 1. 声音静默门限 (RMS/Gate)

人声带有诸多底噪及呼吸音。每次拿到 `2048` 的浮点数据帧，首先计算均方根（RMS，Root Mean Square）。

```python
rms = float(np.sqrt(np.mean(audio_frame ** 2)))
if rms < 0.005:  # 门限值
    return 无效/静音 
```

这么做极大减少了 pYIN 因为处理大量背景白噪声而返回乱跑的随机音高。

### 2. numba JIT 预热控制 (Warmup)

`librosa.pyin` 的实现深度依赖了 `numba`。由于 `numba` 会在第一帧调用时自动触发**前端到机器码的即时编译 (JIT)**，这会导致高达 `3-6秒` 的惊人阻塞。
因此使用了 `lifespan`：在 FastAPI 启动成功的第一秒内，自动送入一帧“静音幽灵帧”进入预热函数，吃下 JIT 的耗时。

### 3. pYIN 执行与拾取

```python
f0, voiced_flag, voiced_prob = librosa.pyin(
    audio_frame, fmin=65 (C2), fmax=2093 (C7), frame_length=2048, hop_length=1024
)
```

- pYIN 算法与直接执行 FFT（傅立叶变换拾取最高峰）最大不同在于它利用自相关函数并采用概率分布评估。
- `voiced_flag`是 pYIN 特有的特征，它不仅仅返回一个数组记录当前的 Hz 数，还可以确定这个频率是不是**真实的发声（Voiced）**，从而过滤掉刺耳的高频齿音。

### 4. 音乐理论计算 (Music Theory)

`backend/pitch/music_theory.py` 负责把 440.0 Hz 转换为常见的西式十二平均律音名：

1. **MIDI基数**：`m = 69 + 12 * log2(Hz / 440)`
   例如，440会严丝合缝算出 MIDI 69
2. **Cents偏差与音准度**：将算出的真实带小数的 MIDI 数值与四舍五入后的**最近整数音**作差，乘以 100 得到音分 (`cents`) 偏差：[-50, +50]。
   - ± 15 内认为是绿色（非常准确）
   - ± 30 内认为是黄色（轻微偏离）
   - 大于等于 30 认为是红色（跑调不准）

---

## 4. 前端渲染实现简述

所有面板渲染类都遵循同一个设计模式：挂载 `requestAnimationFrame` 的内部主循环，且接受通过 WebSocket 抛来的外部更新接口（`.update(msg)`）。这是“被动数据，主动渲染”策略。

### 1. 指针图 (NeedleMeter)

文件：`needle-meter.js`。为了规避检测时偶尔带有的跳动，使用了简易的一阶低通滤波器（`alpha (平滑系数)`），在静止与有效发声的不同状态切换不同的平滑阈值：

```javascript
// 使得长长摇摆的指针更为顺滑而不是抖动刺眼
this._smoothCents += alpha * (cents - this._smoothCents);
```

### 2. 瀑布/音高历史图 (PitchHistory)

文件：`pitch-history.js`。项目的技术难点之二。记录了一个最大长度（默认超过 90 秒自动丢弃，但视口只有 30 秒）。

1. **坐标映射**：将接收到的时间戳归一化至宽度像素（X轴），并且只渲染 `Date.now() - 30s` 范围内的点阵。
2. **多模式绘制**：支持“散点图（点划线）”与“柱状平铺”。通过 `barW` 延长线预测至下个连贯点，实现类似 DAW（宿主音乐软件）一样的大音轨图。
3. **两层平移技术**：将当前的“可视窗口（`view`）”与“自动跟随计算目标窗口（`target`）”独立。如果在自动跟随开启下发生超出屏幕可视区的情况，设置目标窗口 `_target`，然后在下一帧以物理缓动（`LERP`，默认 10% 逼近速度）渲染 `_view` 进行滑动：

```javascript
this._viewMin += (this._targetMin - this._viewMin) * LERP;
```

---

## 5. 项目拓展与后续开发建议

目前 Vocal Tuner 已建立了一个坚实、稳定的基础平台框架。如果您接手本项目希望进一步优化，以下是若干高潜力的开发路径：

### 5.1 降低延迟与实时性优化 (Latency Optimization)

目前设置的 Chunk Size 为 `2048`，对于 44.1kHz 的环境也就是大约 **46 毫秒**的捕获时间，加上 pYIN 计算和网络穿透，渲染出来体感可能有 60-80 毫秒左右的体感。

- **优化思路**：如果未来服务器性能极佳（或切向客户端纯本地运行），可以将 `CHUNK_SIZE` 放缩到 `1024`（带来大约 23 ms的缓冲）。
- **风险提醒**：音频帧越短，pYIN 这类基于自相关采样的算法越难抓住极低音（如 男低音 C2 时波长就很长），它会面临信息量不够的惩罚。

### 5.2 并发及多频道扩展

目前的框架支持多设备获取（见设备下拉框实现），但是 `Capture` 是纯正的“单连接控制设计”。目前的 API `/api/device` 调用会替换全局的麦克风流，并且 `WS` 也是一对一绑定。

- **优化思路**：将 Capture 实例做成基于 `session/id` 维护的可扩展字典；可以让多个用户打开这个页面时，各自开启一个全新的检测实例并指定他们的手机或特定外置声卡流。

### 5.3 Web Audio API 落地（去服务器架构）

现在架构使用“瘦客户渲染器 + 满级运算后台”思路。

- **优化思路**：得益于 WebAssembly (Wasm) 的发展，您可完全将 `pYIN` 算法或甚至其轻量级替代（如 `CREPE` 甚至是开源 `aubio.wasm` 降级引擎）打包置入前端！
  一旦将音频拉取改为页面的 `navigator.mediaDevices.getUserMedia` 并用 `AudioWorklet` 将字节流推给 wasm 计算，不仅完全剥离了服务器流量、去除了延迟负担，还可以作为极其方便的 PWA 直接离线运行。

### 5.4 更多视域的改进 (UI/UX)

- **历史谱面的横轴自适应**：目前默认锁定 30 秒（或通过鼠标缩放 Y轴）。可以设计针对 X 轴鼠标左右拖拽与时间轴压缩，浏览之前被截断的 90 秒全局数据！
- **参考导唱支持**：可以上传一段 MIDI 解析后并在 PitchHistory 后方直接绘出一条半透明灰色的音轨导线。当检测的录音音轨与参照轨对齐且重叠时产生华丽的打光，极大的提升唱歌练习用户的视听体验反馈。
