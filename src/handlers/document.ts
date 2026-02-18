/**
 * Document handler for Claude Telegram Bot.
 *
 * Supports PDFs and text files with media group buffering.
 * PDF extraction uses pdftotext CLI (install via: brew install poppler)
 */

import type { Context } from "grammy";
import { getSession } from "../session";
import { ALLOWED_USERS, TEMP_DIR } from "../config";
import {
  isAuthorized,
  rateLimiter,
} from "../security";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { createMediaGroupBuffer, handleProcessingError } from "./media-group";
import { isAudioFile, processAudioFile } from "./audio";

/**
 * Escape a string for safe use in XML attribute values.
 */
function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Supported text file extensions
const TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".env",
  ".log",
  ".cfg",
  ".ini",
  ".toml",
];

// Supported archive extensions
const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz"];

// Max file size (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Max content from archive (50K chars total)
const MAX_ARCHIVE_CONTENT = 50000;

// Max extracted archive size (100MB - zip bomb protection)
const MAX_EXTRACTED_SIZE = 100 * 1024 * 1024;

// Create document-specific media group buffer
const documentBuffer = createMediaGroupBuffer({
  emoji: "📄",
  itemLabel: "document",
  itemLabelPlural: "documents",
});

/**
 * Download a document and return the local path.
 */
async function downloadDocument(ctx: Context): Promise<string> {
  const doc = ctx.message?.document;
  if (!doc) {
    throw new Error("No document in message");
  }

  const file = await ctx.getFile();
  const fileName = doc.file_name || `doc_${Date.now()}`;

  // Sanitize filename with unique prefix to prevent collisions (M2)
  const timestamp = Date.now();
  const random = crypto.randomUUID().slice(0, 8);
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const safeName = `doc_${timestamp}_${random}_${sanitized}`;
  const docPath = `${TEMP_DIR}/${safeName}`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(docPath, buffer);

  return docPath;
}

/**
 * Extract text from a document.
 */
async function extractText(
  filePath: string,
  mimeType?: string
): Promise<string> {
  const fileName = filePath.split("/").pop() || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();

  // PDF extraction using pdftotext CLI (install: brew install poppler)
  if (mimeType === "application/pdf" || extension === ".pdf") {
    try {
      const result = await Bun.$`pdftotext -layout ${filePath} -`.quiet();
      return result.text();
    } catch (error) {
      console.error("PDF parsing failed:", error);
      return "[PDF parsing failed - ensure pdftotext is installed: brew install poppler]";
    }
  }

  // Text files
  if (TEXT_EXTENSIONS.includes(extension) || mimeType?.startsWith("text/")) {
    const text = await Bun.file(filePath).text();
    // Limit to 100K chars
    return text.slice(0, 100000);
  }

  throw new Error(`Unsupported file type: ${extension || mimeType}`);
}

/**
 * Check if a file extension is an archive.
 */
function isArchive(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Get archive extension from filename.
 */
function getArchiveExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tgz")) return ".tgz";
  if (lower.endsWith(".tar")) return ".tar";
  if (lower.endsWith(".zip")) return ".zip";
  return "";
}

/**
 * Extract an archive to a temp directory.
 */
async function extractArchive(
  archivePath: string,
  fileName: string
): Promise<string> {
  const ext = getArchiveExtension(fileName);
  const extractDir = `${TEMP_DIR}/archive_${Date.now()}`;
  await Bun.$`mkdir -p ${extractDir}`;

  if (ext === ".zip") {
    // Check for path traversal entries before extraction
    const listResult = await Bun.$`unzip -l ${archivePath}`.quiet();
    const entries = listResult.text().split("\n");
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (trimmed.includes("../") || trimmed.startsWith("/")) {
        throw new Error("Archive contains path traversal entries");
      }
    }
    // Extract preserving directory structure (-o: overwrite)
    await Bun.$`unzip -q -o ${archivePath} -d ${extractDir}`.quiet();
  } else if (ext === ".tar" || ext === ".tar.gz" || ext === ".tgz") {
    // --no-same-permissions: prevent SUID, --no-absolute-names: prevent path traversal
    await Bun.$`tar --no-same-permissions --no-absolute-names -xf ${archivePath} -C ${extractDir}`.quiet();
  } else {
    throw new Error(`Unknown archive type: ${ext}`);
  }

  // Remove symlinks to prevent path traversal (SEC-007)
  await Bun.$`find ${extractDir} -type l -delete`.quiet();

  // Check extracted size (zip bomb protection M4)
  try {
    const duResult = await Bun.$`du -sk ${extractDir}`.quiet();
    const extractedSizeKB = parseInt(duResult.text().split("\t")[0] || "0", 10);
    const extractedSize = extractedSizeKB * 1024;
    if (extractedSize > MAX_EXTRACTED_SIZE) {
      await Bun.$`rm -rf ${extractDir}`.quiet();
      throw new Error("Archive too large when extracted (possible zip bomb)");
    }
  } catch (error) {
    if (String(error).includes("zip bomb")) throw error;
    // du failed - continue with caution
  }

  return extractDir;
}

/**
 * Build a file tree from a directory.
 */
async function buildFileTree(dir: string): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: dir, dot: false })
  );
  entries.sort();
  return entries.slice(0, 100); // Limit to 100 files
}

/**
 * Extract text content from archive files.
 */
async function extractArchiveContent(
  extractDir: string
): Promise<{
  tree: string[];
  contents: Array<{ name: string; content: string }>;
}> {
  const tree = await buildFileTree(extractDir);
  const contents: Array<{ name: string; content: string }> = [];
  let totalSize = 0;

  for (const relativePath of tree) {
    const fullPath = `${extractDir}/${relativePath}`;
    const stat = await Bun.file(fullPath).exists();
    if (!stat) continue;

    // Check if it's a directory
    const fileInfo = Bun.file(fullPath);
    const size = fileInfo.size;
    if (size === 0) continue;

    const ext = "." + (relativePath.split(".").pop() || "").toLowerCase();
    if (!TEXT_EXTENSIONS.includes(ext)) continue;

    // Skip large files
    if (size > 100000) continue;

    try {
      const text = await fileInfo.text();
      const truncated = text.slice(0, 10000); // 10K per file max
      if (totalSize + truncated.length > MAX_ARCHIVE_CONTENT) break;
      contents.push({ name: relativePath, content: truncated });
      totalSize += truncated.length;
    } catch {
      // Skip binary or unreadable files
    }
  }

  return { tree, contents };
}

/**
 * Process an archive file.
 */
async function processArchive(
  ctx: Context,
  archivePath: string,
  fileName: string,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  const session = getSession(userId);
  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  // Show extraction progress
  const statusMsg = await ctx.reply(`📦 Extracting <b>${fileName}</b>...`, {
    parse_mode: "HTML",
  });

  try {
    // Extract archive
    console.log(`Extracting archive: ${fileName}`);
    const extractDir = await extractArchive(archivePath, fileName);
    const { tree, contents } = await extractArchiveContent(extractDir);
    console.log(`Extracted: ${tree.length} files, ${contents.length} readable`);

    // Update status
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `📦 Extracted <b>${fileName}</b>: ${tree.length} files, ${contents.length} readable`,
      { parse_mode: "HTML" }
    );

    // Build prompt with content delimiters (SEC-001)
    const treeStr = tree.length > 0 ? tree.join("\n") : "(empty)";
    const contentsStr =
      contents.length > 0
        ? contents.map((c) => `--- ${c.name} ---\n${c.content}`).join("\n\n")
        : "(no readable text files)";

    const wrappedContent = `<user_document name="${escapeXmlAttr(fileName)}" type="archive">\nFile tree (${tree.length} files):\n${treeStr}\n\nExtracted contents:\n${contentsStr}\n</user_document>`;

    const prompt = caption
      ? `${wrappedContent}\n\n<user_caption>${caption}</user_caption>`
      : `Please analyze this archive (${fileName}):\n\n${wrappedContent}`;

    // Set conversation title (if new session)
    if (!session.isActive) {
      const rawTitle = caption || `[Archivio: ${fileName}]`;
      const title =
        rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
      session.conversationTitle = title;
    }

    // Create streaming state
    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);

    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(
      userId,
      username,
      "ARCHIVE",
      `[${fileName}] ${caption || ""}`,
      response
    );

    // Cleanup
    await Bun.$`rm -rf ${extractDir}`.quiet();

    // Delete status message
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore deletion errors
    }
  } catch (error) {
    console.error("Archive processing error:", error);
    // Delete status message on error
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore
    }
    console.error("Archive processing error detail:", error);
    await ctx.reply("❌ Archiv konnte nicht verarbeitet werden.");
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * Process documents with Claude.
 */
async function processDocuments(
  ctx: Context,
  documents: Array<{ path: string; name: string; content: string }>,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  const session = getSession(userId);
  // Mark processing started
  const stopProcessing = session.startProcessing();

  // Build prompt with content delimiters (SEC-001)
  let prompt: string;
  if (documents.length === 1) {
    const doc = documents[0]!;
    const wrappedContent = `<user_document name="${escapeXmlAttr(doc.name)}">\n${doc.content}\n</user_document>`;
    prompt = caption
      ? `${wrappedContent}\n\n<user_caption>${caption}</user_caption>`
      : `Please analyze this document (${doc.name}):\n\n${wrappedContent}`;
  } else {
    const docList = documents
      .map(
        (d) =>
          `<user_document name="${escapeXmlAttr(d.name)}">\n${d.content}\n</user_document>`
      )
      .join("\n\n");
    prompt = caption
      ? `${documents.length} Documents:\n\n${docList}\n\n<user_caption>${caption}</user_caption>`
      : `Please analyze these ${documents.length} documents:\n\n${docList}`;
  }

  // Set conversation title (if new session)
  if (!session.isActive) {
    const docName = documents[0]?.name || "[Documento]";
    const rawTitle = caption || `[Documento: ${docName}]`;
    const title =
      rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
    session.conversationTitle = title;
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(
      userId,
      username,
      "DOCUMENT",
      `[${documents.length} docs] ${caption || ""}`,
      response
    );
  } catch (error) {
    await handleProcessingError(ctx, error, state.toolMessages);
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * Process document paths by extracting text and calling processDocuments.
 */
async function processDocumentPaths(
  ctx: Context,
  paths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  // Extract text from all documents
  const documents: Array<{ path: string; name: string; content: string }> = [];

  for (const path of paths) {
    try {
      const name = path.split("/").pop() || "document";
      const content = await extractText(path);
      documents.push({ path, name, content });
    } catch (error) {
      console.error(`Failed to extract ${path}:`, error);
    }
  }

  if (documents.length === 0) {
    await ctx.reply("❌ Failed to extract any documents.");
    return;
  }

  await processDocuments(ctx, documents, caption, userId, username, chatId);
}

/**
 * Handle incoming document messages.
 */
export async function handleDocument(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const doc = ctx.message?.document;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId || !doc) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check file size
  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
    await ctx.reply("❌ File too large. Maximum size is 10MB.");
    return;
  }

  // 3. Check file type
  const fileName = doc.file_name || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();
  const isPdf = doc.mime_type === "application/pdf" || extension === ".pdf";
  const isText =
    TEXT_EXTENSIONS.includes(extension) || doc.mime_type?.startsWith("text/");
  const isArchiveFile = isArchive(fileName);

  // Check if it's an audio file sent as a document
  if (!isPdf && !isText && !isArchiveFile && isAudioFile(fileName, doc.mime_type)) {
    console.log(`Received audio document: ${fileName} from @${username}`);

    // Rate limit check
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    // Download and process as audio
    let docPath: string;
    try {
      docPath = await downloadDocument(ctx);
    } catch (error) {
      console.error("Failed to download audio document:", error);
      await ctx.reply("❌ Failed to download audio file.");
      return;
    }

    await processAudioFile(ctx, docPath, ctx.message?.caption, userId, username, chatId);
    return;
  }

  if (!isPdf && !isText && !isArchiveFile) {
    await ctx.reply(
      `❌ Unsupported file type: ${extension || doc.mime_type}\n\n` +
        `Supported: PDF, archives (${ARCHIVE_EXTENSIONS.join(
          ", "
        )}), ${TEXT_EXTENSIONS.join(", ")}`
    );
    return;
  }

  // 4. Download document
  let docPath: string;
  try {
    docPath = await downloadDocument(ctx);
  } catch (error) {
    console.error("Failed to download document:", error);
    await ctx.reply("❌ Failed to download document.");
    return;
  }

  // 5. Archive files - process separately (no media group support)
  if (isArchiveFile) {
    console.log(`Received archive: ${fileName} from @${username}`);
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    await processArchive(
      ctx,
      docPath,
      fileName,
      ctx.message?.caption,
      userId,
      username,
      chatId
    );
    return;
  }

  // 6. Single document - process immediately
  if (!mediaGroupId) {
    console.log(`Received document: ${fileName} from @${username}`);
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    try {
      const content = await extractText(docPath, doc.mime_type);
      await processDocuments(
        ctx,
        [{ path: docPath, name: fileName, content }],
        ctx.message?.caption,
        userId,
        username,
        chatId
      );
    } catch (error) {
      console.error("Failed to extract document:", error);
      console.error("Document processing error detail:", error);
      await ctx.reply("❌ Dokument konnte nicht verarbeitet werden.");
    }
    return;
  }

  // 7. Media group - buffer with timeout
  await documentBuffer.addToGroup(
    mediaGroupId,
    docPath,
    ctx,
    userId,
    username,
    processDocumentPaths
  );
}
