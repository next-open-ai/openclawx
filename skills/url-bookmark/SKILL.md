---
name: url-bookmark
description: 根据用户指令将 URL 保存为收藏，并匹配系统中已维护的标签。当用户说「收藏这个链接」「把这条存到技术标签」「保存网址」等时使用。先调用 get_bookmark_tags 获取可用标签列表；若缺少用户想要的标签，可用 add_bookmark_tag 新增标签，再根据用户意图选择标签，最后用 save_bookmark 保存。
allowed-tools: get_bookmark_tags, save_bookmark, add_bookmark_tag
---

# URL 收藏技能

## 何时使用

当用户希望**保存一个链接/URL 到收藏**时使用本技能，例如：

- 「收藏这个链接」「把这条链接存一下」
- 「把这个网址加到技术标签」「存到待读里」
- 「保存当前页面」「记一下这个地址」

## 工作流程

1. **获取可用标签**：先调用工具 `get_bookmark_tags`，获取系统中已维护的标签列表（用户可在「设置 → 标签管理」中维护，或由本技能通过工具新增）。
2. **缺标签时新增**：若用户指定的标签（如「美女」「技术」「待读」）不在 `get_bookmark_tags` 返回列表中，先调用 `add_bookmark_tag` 传入该标签名完成新增，再调用 `get_bookmark_tags` 获取最新列表（或直接使用刚创建的标签名）。
3. **理解用户意图**：从用户话里提取：
   - 要收藏的 **URL**（用户可能直接给出，或说「当前页面」「刚发的那条」等，需结合上下文确定）；
   - 用户指定的**标签**（须与系统已有标签名一致；若不存在则先用 `add_bookmark_tag` 创建）；
   - 若用户未指定标签，可根据内容推断一个已有标签或留空。
4. **保存收藏**：调用工具 `save_bookmark`，传入 `url`（必填）、`title`（可选）、`tagNames`（可选，字符串数组，须为系统已有标签名）。

## 工具说明

- **get_bookmark_tags**：无参数。返回当前可用的标签名称列表，供后续匹配。
- **add_bookmark_tag**：参数 `tagName`（必填，字符串）。在系统中新增一个标签；若标签已存在会提示无需重复创建。缺少某标签时先调用本工具再保存收藏。
- **save_bookmark**：参数 `url`（必填）、`title`（可选）、`tagNames`（可选，字符串数组）。标签名须为系统已有标签（可来自 get_bookmark_tags 或 add_bookmark_tag 刚创建）。

## 注意

- 用户说「存到某某分类/标签」且该标签不存在时，先 `add_bookmark_tag` 再 `save_bookmark`。
- 若尚无任何标签，可只保存 URL 不传 `tagNames`，或先 `add_bookmark_tag` 再保存。
