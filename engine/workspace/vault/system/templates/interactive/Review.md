<%*
const period = await tp.system.suggester(
  ["Weekly Review", "Monthly Review", "Yearly Review"],
  ["weekly", "monthly", "yearly"],
  false,
  "选择复盘周期",
);
if (!period) throw new Error("Review 创建已取消");

const now = new Date();
const year = now.getFullYear();
const month = now.getMonth();
const pad = (value) => String(value).padStart(2, "0");
const dateText = (value) =>
  `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
let key;
let title;
let start;
let end;

if (period === "weekly") {
  const current = new Date(Date.UTC(year, month, now.getDate()));
  const weekday = current.getUTCDay() || 7;
  start = new Date(current);
  start.setUTCDate(current.getUTCDate() - weekday + 1);
  end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const thursday = new Date(current);
  thursday.setUTCDate(current.getUTCDate() + 4 - weekday);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
  key = `${isoYear}-W${pad(week)}`;
  title = `${key} Weekly Review`;
} else if (period === "monthly") {
  key = `${year}-${pad(month + 1)}`;
  title = `${key} Monthly Review`;
  start = new Date(Date.UTC(year, month, 1));
  end = new Date(Date.UTC(year, month + 1, 0));
} else {
  key = String(year);
  title = `${key} Yearly Review`;
  start = new Date(Date.UTC(year, 0, 1));
  end = new Date(Date.UTC(year, 11, 31));
}

const periodRange = `${dateText(start)} — ${dateText(end)}`;
const target = `life/reviews/${period}/${key}`;
if (app.vault.getAbstractFileByPath(`${target}.md`)) {
  throw new Error(`本期 Review 已存在：${target}.md。请直接打开已有文件，或从 Dashboard 的 Life 页面进入。`);
}
await tp.file.move(target);
-%>
---
type: Review
title: "<% title %>"
created_at: "<% tp.date.now('YYYY-MM-DDTHH:mm:ssZ') %>"
---

# <% title %>

> 复盘范围：<% periodRange %>

## 本期回看

- 最重要的进展：
- 实际投入最多的事情：
- 值得记住的变化：

## 做得好的

- 

## 阻力与偏差

- 

## 学到与改变

- 

## 下一周期

- 继续：
- 停止：
- 开始：
- 最重要的一件事：

## 补充记录

<!-- ai:auto:start name="organized-review" -->
<!-- ai:auto:end name="organized-review" -->
