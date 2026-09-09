import type { WorkstationStrings } from "./en";

export const zhCN: WorkstationStrings = {
  nav: {
    needAttention: "需要关注",
    running: "运行中",
    currentWorkspace: "当前工作区",
    recentlyVisited: "最近访问",
    workspaceManagement: "工作区管理",
    archived: "已归档",
  },
  status: {
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
  },
  composer: {
    send: "发送",
    queue: "排队",
    steer: "转向",
    emptyHint: "发送前请输入非空白文本或添加已接受的附件。",
    requestControl: "请求控制权",
  },
  sideChat: {
    newChat: "新旁路对话",
    ask: "提问",
    copy: "复制",
    insertDraft: "插入草稿",
    staleBadge: "上下文已过期——主任务有更新的内容",
    refresh: "刷新上下文",
    closeWarning: "将被删除且无法恢复",
  },
  inspector: {
    openPanel: "打开面板",
    addPanel: "添加检查器面板",
    closeTab: "关闭标签",
    pinTab: "固定标签",
  },
};
