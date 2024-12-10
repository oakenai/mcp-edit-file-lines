import fs from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { editFile } from "../fileEditor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("fileEditor", () => {
  // Helper to create a temporary file for testing
  async function createTempFile(content: string): Promise<string> {
    const tempPath = join(__dirname, "fixtures", `temp-${Date.now()}.txt`);
    await fs.writeFile(tempPath, content);
    return tempPath;
  }

  // Clean up temp files after each test
  afterEach(async () => {
    const files = await fs.readdir(join(__dirname, "fixtures"));
    for (const file of files) {
      if (file.startsWith("temp-")) {
        await fs.unlink(join(__dirname, "fixtures", file));
      }
    }
  });

  it("should handle single line replacements", async () => {
    const content = "line 1\nline 2\nline 3\n";
    const tempPath = await createTempFile(content);

    const result = await editFile({
      p: tempPath,
      e: [[2, 2, "replaced line"]]
    });

    const newContent = await fs.readFile(tempPath, "utf-8");
    expect(newContent).toBe("line 1\nreplaced line\nline 3\n");
    expect(result).toContain("-line 2");
    expect(result).toContain("+replaced line");
  });

  it("should handle multiple line replacements", async () => {
    const content = "line 1\nline 2\nline 3\nline 4\nline 5\n";
    const tempPath = await createTempFile(content);

    const result = await editFile({
      p: tempPath,
      e: [[2, 4, "new line 1\nnew line 2"]]
    });

    const newContent = await fs.readFile(tempPath, "utf-8");
    expect(newContent).toBe("line 1\nnew line 1\nnew line 2\nline 5\n");
  });

  it("should process edits in reverse line order", async () => {
    const content = "line 1\nline 2\nline 3\nline 4\nline 5\n";
    const tempPath = await createTempFile(content);

    const result = await editFile({
      p: tempPath,
      e: [
        [1, 1, "first line"],
        [4, 4, "fourth line"]
      ]
    });

    const newContent = await fs.readFile(tempPath, "utf-8");
    expect(newContent).toBe(
      "first line\nline 2\nline 3\nfourth line\nline 5\n"
    );
  });

  it("should throw error for overlapping ranges", async () => {
    const content = "line 1\nline 2\nline 3\nline 4\n";
    const tempPath = await createTempFile(content);

    await expect(
      editFile({
        p: tempPath,
        e: [
          [1, 2, "overlap 1"],
          [2, 3, "overlap 2"]
        ]
      })
    ).rejects.toThrow("Line 2 is affected by multiple edits");
  });

  describe("line range validation", () => {
    let tempPath: string;

    beforeEach(async () => {
      const content = "line 1\nline 2\nline 3\n";
      tempPath = await createTempFile(content);
    });

    it("should allow equal start and end line numbers", async () => {
      const result = await editFile({
        p: tempPath,
        e: [[2, 2, "same line"]]
      });

      const newContent = await fs.readFile(tempPath, "utf-8");
      expect(newContent).toBe("line 1\nsame line\nline 3\n");
    });

    it("should throw error when start line is greater than end line", async () => {
      await expect(
        editFile({
          p: tempPath,
          e: [[3, 2, "invalid range"]]
        })
      ).rejects.toThrow(
        "Invalid range: start line 3 is greater than end line 2"
      );
    });

    it("should throw error for zero line numbers", async () => {
      await expect(
        editFile({
          p: tempPath,
          e: [[0, 1, "invalid"]]
        })
      ).rejects.toThrow("Line numbers must be positive integers");

      await expect(
        editFile({
          p: tempPath,
          e: [[1, 0, "invalid"]]
        })
      ).rejects.toThrow("Line numbers must be positive integers");
    });

    it("should throw error for negative line numbers", async () => {
      await expect(
        editFile({
          p: tempPath,
          e: [[-1, 1, "invalid"]]
        })
      ).rejects.toThrow("Line numbers must be positive integers");

      await expect(
        editFile({
          p: tempPath,
          e: [[1, -1, "invalid"]]
        })
      ).rejects.toThrow("Line numbers must be positive integers");
    });
  });

  it("should handle dry run without modifying file", async () => {
    const content = "line 1\nline 2\nline 3\n";
    const tempPath = await createTempFile(content);

    const result = await editFile(
      {
        p: tempPath,
        e: [[2, 2, "replaced line"]]
      },
      true
    );

    const newContent = await fs.readFile(tempPath, "utf-8");
    expect(newContent).toBe(content); // File should be unchanged
    expect(result).toContain("diff"); // But diff should be generated
  });

  it("should handle complex React component replacement", async () => {
    const content = `<Grid item xs={3}>
            <KPICard
              title="Fleet Utilization"
              value={Math.round(report.data.asset_metrics.summary.avg_utilization_rate)}
              color="error"
              isLoading={isLoading}
            />
          </Grid>`;
    const tempPath = await createTempFile(content);

    const result = await editFile({
      p: tempPath,
      e: [
        [
          2,
          7,
          `            <CustomTab
              label="Driver Performance"
              tabcolor={TAB_COLORS.driver}
              active={currentTabIndex}
              activeBorderBottomColor={getTabColor(currentTabIndex)}
            />`
        ]
      ]
    });

    const newContent = await fs.readFile(tempPath, "utf-8");
    expect(newContent).toContain("CustomTab");
    expect(newContent).toContain("Driver Performance");
    expect(newContent).not.toContain("KPICard");
  });
});