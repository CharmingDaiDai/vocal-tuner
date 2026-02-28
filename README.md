# 🎤 Vocal Tuner — 实时音准检测系统

基于浏览器的实时人声音准检测与可视化工具。麦克风输入经后端 pYIN 算法检测基频后，通过 WebSocket 推送至前端，以四种可视化面板实时呈现音准状态。

---

## 功能概览

| 功能 | 说明 |
|------|------|
| 实时音准检测 | pYIN 算法，延迟 ~50 ms，检测范围 C2–C7 |
| 指针调音表 | 半圆刻度盘 + 指针 + 大字音名，颜色编码音准 |
| 音高历史 | 30 秒滚动时间轴，点线 / 柱状两种风格，自动跟随音高 |
| 钢琴键盘 | C2–B5（4 个八度），当前音符高亮 |
| FFT 频谱 | 0–4000 Hz 实时频谱，基频橙色标注 |
| 麦克风切换 | 运行时热切换输入设备，无需重启 |
| 数据导出 | 一键导出 CSV（时间戳 / 频率 / 音名 / 音分 / 置信度）|

---

## 快速启动

### 1. 环境准备（仅首次）

```bash
conda create -n vocal-tuner python=3.11 -y
conda activate vocal-tuner
cd E:\Project\vocal-tuner\backend
pip install -r requirements.txt
```

### 2. 启动服务

```bash
conda activate vocal-tuner
cd E:\Project\vocal-tuner\backend
uvicorn main:app --host 0.0.0.0 --port 8000
```

### 3. 打开浏览器

```
http://localhost:8000
```

点击 **▶ 开始** 即可实时检测。

---

## 项目结构

```
vocal-tuner/
├── backend/
│   ├── main.py                 # FastAPI 应用入口，WebSocket 推流
│   ├── requirements.txt        # Python 依赖
│   ├── audio/
│   │   └── capture.py          # sounddevice 麦克风采集
│   └── pitch/
│       ├── detector.py         # pYIN 音高检测 + FFT 计算
│       └── music_theory.py     # 频率 ↔ 音符转换
├── frontend/
│   ├── index.html              # 单页应用主文件
│   ├── css/
│   │   └── style.css           # 深色主题样式
│   └── js/
│       ├── ws-client.js        # WebSocket 连接管理
│       ├── recorder.js         # 历史记录 + CSV 导出
│       └── visualizers/
│           ├── needle-meter.js # 指针调音表
│           ├── pitch-history.js# 音高历史时间轴
│           ├── piano.js        # 钢琴键盘
│           └── fft-spectrum.js # FFT 频谱图
└── environment.yml             # conda 环境快照
```

---

## 技术栈

- **后端**：Python 3.11 · FastAPI · uvicorn · sounddevice · librosa · scipy · numpy  
- **前端**：原生 HTML5 Canvas · ES Modules · 无框架 / 无构建工具  
- **通信**：WebSocket（实时推流）+ REST API（控制指令）

---

## 常用操作

| 操作 | 方式 |
|------|------|
| 暂停 / 继续 | Header 按钮 |
| 切换麦克风 | Header 下拉框，实时生效 |
| 导出数据 | 💾 导出 CSV 按钮 |
| 音高历史缩放 | 鼠标滚轮 / ＋ / － 按钮 |
| 切换显示风格 | **点线** / **柱状** 按钮 |
| 自动跟随音高 | **跟随** 按钮（蓝色 = 开启）|
| 全屏历史面板 | ⛶ 按钮，按 ESC 退出 |

---

## 详细技术文档

见 [TECHNICAL.md](TECHNICAL.md)
