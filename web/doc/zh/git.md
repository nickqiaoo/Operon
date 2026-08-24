# Git

Operon 不打算取代你的 git 工作流——它只去掉两个打断专注的步骤：写 commit message，以及切到终端去 push。

## 提交

从 git 控件打开 **Commit or push** 对话框。它会显示当前分支和改动的文件数。

- **Include unstaged changes** 会在提交前把所有改动加入暂存区，你不必先 `git add`。
- **Commit message** 是真正有用的部分：留空，Operon 就会根据暂存的 diff 替你写一条。
- **Next steps** 决定实际执行什么——commit、commit 并 push、或只 push。选择 push 时会出现 **Force push**。

## 自动生成的提交信息

当消息框为空时，Operon 会让模型根据暂存的 diff 写一条。

在 **Settings > Commit message generation** 里配置：选择要用的 provider 和模型。模型以无头方式运行，diff 直接内联在请求里——不调用工具、不访问文件，除了 diff 和一次请求之外什么都没有。这是一个刻意做小、做快的任务，所以值得把它指向一个便宜的模型，而不是你主力的编码模型。

如果你自己写了消息，就完全不会调用模型。

## 提交前的审阅

**Review** 面板标签会显示工作区的 diff。Agent 完成改动之后，通常的循环就是：在那里读它到底做了什么，然后从对话框提交——以你自己的名义。
