// re-soft 主脚本：当前为脚手架占位逻辑，验证页面交互是否可用
// 后续按实际功能需求在此扩展

// 项目版本常量：与 index.html 标题、徽标保持一致，便于统一维护
const VERSION = "1.0.0";

// 页面加载完成后绑定交互，确保 DOM 已就绪
document.addEventListener("DOMContentLoaded", function () {
  // 在控制台打印版本，方便调试时确认脚本已加载
  console.log("re-soft 已加载，版本：" + VERSION);

  // 获取按钮与输出区元素
  const button = document.getElementById("ctaButton");
  const output = document.getElementById("output");

  // 若元素存在则绑定点击事件（防御性判断，避免元素缺失报错）
  if (button && output) {
    button.addEventListener("click", function () {
      // 点击后给出反馈，证明 JS 与 DOM 联动正常
      output.textContent = "✅ 交互正常，re-soft " + VERSION + " 运行中";
    });
  }
});
