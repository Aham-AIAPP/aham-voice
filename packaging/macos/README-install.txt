AhamVoice 安装说明（macOS · Apple Silicon）

1. 把 AhamVoice 拖到「应用程序」(Applications)。

2. 第一次打开前，因为这个 app 没有 Apple 付费签名，需要解除隔离：
   打开「终端」(Terminal)，粘贴并回车：

       xattr -dr com.apple.quarantine "/Applications/Aham Voice.app"

   （或者：在「应用程序」里右键点 AhamVoice → 打开 → 再点「打开」。）

3. 双击 AhamVoice 启动。首次启动会在
   ~/Library/Application Support/AhamVoice 下创建数据目录。

4. 录音转写、说话人分离、声学情绪识别 全部本地运行，无需联网、无需配置。

5. 「会议纪要」「对话情绪的语义分析」需要云端大模型：
   打开 app 左下「设置」，填入你自己的 DeepSeek API Key（platform.deepseek.com 获取），
   保存即可。Key 只存在本机，不会上传。

仅支持 Apple Silicon (M 系列) Mac，macOS 12 及以上。
