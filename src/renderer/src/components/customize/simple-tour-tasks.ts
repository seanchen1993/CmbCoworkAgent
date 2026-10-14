export const simpleTourTasks = [
  {
    task: "create",
    name: "创建我的插件",
    steps: [
      {
        title: "选择要复制的插件",
        action: "选择 AutoBiz",
        text: "从完整 AutoBiz 开始，保留已有技能和工作步骤。"
      },
      {
        title: "给新插件取名",
        action: "创建我的副本",
        text: "新副本独立保存，下一步只需描述业务目标。"
      },
      {
        title: "描述目标，核对后保存",
        action: "去创建我的插件",
        text: "用一句话描述新需求，助手会补充技能说明。看过修改前后内容，再确认保存。想自己挑选项目步骤，可在安装前点击“添加自选步骤选项”。"
      }
    ]
  },
  {
    task: "combine",
    name: "搭配两个插件",
    steps: [
      {
        title: "选两个插件",
        action: "选择 AutoBiz 和 Review",
        text: "这个示例先用 AutoBiz 的文件读取功能，再让 Review 检查文件内容。使用时需选择支持这两项操作的插件。"
      },
      {
        title: "选择先后执行",
        action: "把文件交给第二步检查",
        text: "第一步的文件内容传给第二步，不用复制粘贴。"
      },
      {
        title: "准备首次任务",
        action: "去搭配我的插件",
        text: "在真实页面填入需求和文件，核对应用后回聊天发送任务。"
      }
    ]
  },
  {
    task: "inspect",
    name: "查看改动和运行结果",
    steps: [
      {
        title: "找到文件改动",
        action: "输入 /diff",
        text: "在聊天输入 /diff，可打开当前项目的改动。"
      },
      {
        title: "先解决文件问题",
        action: "选择正确文件并重新检查",
        text: "文件没找到时，先核对项目与路径，再重新检查。"
      },
      {
        title: "查看结果与依据",
        action: "查看我的项目改动",
        text: "改动在“查看改动”，步骤结果和失败原因在“运行过程”。"
      }
    ]
  }
] as const
