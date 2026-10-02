// 代码加载变量测试用：被 NODE_OPTIONS=--require 预加载时，会在启动层自己的代码运行**之前**执行，
// 往 LP_PRELOAD_MARKER 指定的路径写一个标记文件。测试用它证明「这一步启动层挡不住，只能靠宿主在建进程前清掉」。
require('node:fs').writeFileSync(process.env.LP_PRELOAD_MARKER, 'preload ran before the launcher');
