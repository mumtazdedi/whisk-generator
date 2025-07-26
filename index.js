#!/usr/bin/env node

import fetch from "node-fetch";
import fs from "fs/promises";
import * as fsSync from "fs";
import path from "path";
import readline from "readline";
import { program } from "commander";
import chalk from "chalk";
import ora from "ora";
import sharp from "sharp";

class WhiskClient {
  constructor(authorizationKey) {
    this.credentials = { authorizationKey };
  }

  async checkCredentials() {
    if (!this.credentials.authorizationKey) {
      throw new Error("Missing authorization key");
    }
  }

  async getNewProjectId(name) {
    // Return a timestamp-based ID for demo
    return { Ok: `project_${Date.now()}` };
  }

  async generateImage(prompt) {
    await this.checkCredentials();

    if (!prompt || !prompt.prompt) {
      return {
        Err: new Error("Invalid prompt. Please provide a valid prompt"),
      };
    }

    if (!prompt.projectId) {
      const id = await this.getNewProjectId("New Project");
      if (id.Err || !id.Ok) return { Err: id.Err };
      prompt.projectId = id.Ok;
    }

    if (prompt.seed == undefined) {
      prompt.seed = Math.floor(Math.random() * 1000000);
    }

    if (!prompt.imageModel) {
      prompt.imageModel = "IMAGEN_3_5";
    }

    if (!prompt.aspectRatio) {
      prompt.aspectRatio = "IMAGE_ASPECT_RATIO_LANDSCAPE";
    }

    const reqJson = {
      clientContext: {
        workflowId: prompt.projectId,
        tool: "BACKBONE",
        sessionId: `;${Date.now()}`,
      },
      imageModelSettings: {
        imageModel: prompt.imageModel,
        aspectRatio: prompt.aspectRatio,
      },
      seed: prompt.seed,
      prompt: prompt.prompt,
      mediaCategory: "MEDIA_CATEGORY_BOARD",
    };

    const req = {
      method: "POST",
      body: JSON.stringify(reqJson),
      url: "https://aisandbox-pa.googleapis.com/v1/whisk:generateImage",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${String(this.credentials.authorizationKey)}`,
      },
    };

    const resp = await this.request(req);
    if (resp.Err || !resp.Ok) {
      return { Err: resp.Err };
    }

    try {
      const parsedResp = JSON.parse(resp.Ok);
      if (parsedResp.error) {
        return { Err: new Error("Failed to generate image: " + resp.Ok) };
      }
      return { Ok: parsedResp };
    } catch (err) {
      return { Err: new Error("Failed to parse response: " + resp.Ok) };
    }
  }

  async request(req) {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });

    if (!response.ok) {
      return { Err: new Error(`HTTP error! status: ${response.status}`) };
    }

    const data = await response.text();
    return { Ok: data };
  }
}

class WhiskTerminalApp {
  constructor() {
    this.settingsFile = "./settings.json";
    this.config = {
      tokens: [], // Stores objects with { name, token } instead of just token strings
      outputDir: "./generated-images",
      aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
      aspectRatioDisplay: "landscape (16:9)",
      randomAspectRatio: false,
      compression: 80,
      workers: 1,
      promptFile: null,
      requestDelay: 1000,
    };
    this.clients = [];
    this.currentTokenIndex = 0;
  }

  async autoLoadSettings() {
    try {
      const data = await fs.readFile(this.settingsFile, "utf-8");
      const savedSettings = JSON.parse(data);

      // Merge saved settings with defaults
      this.config = {
        ...this.config,
        ...savedSettings,
      };

      // Migrate old token format (simple strings) to new format (objects with name and token)
      if (
        this.config.tokens.length > 0 &&
        typeof this.config.tokens[0] === "string"
      ) {
        console.log(chalk.blue("Migrating tokens to named format..."));
        this.config.tokens = this.config.tokens.map((token, index) => ({
          name: `Token ${index + 1}`,
          token: token,
        }));
        // Will auto-save after migration
        await this.autoSaveSettings();
      }

      // Initialize clients
      this.initializeClients();

      console.log(
        chalk.green(`✓ Settings auto-loaded from ${this.settingsFile}`),
      );
    } catch (error) {
      console.log(
        chalk.yellow(
          `⚠️  No settings found, using defaults. Will create ${this.settingsFile} on first save.`,
        ),
      );
    }
  }

  async autoSaveSettings() {
    try {
      await fs.writeFile(
        this.settingsFile,
        JSON.stringify(this.config, null, 2),
      );
      console.log(chalk.gray(`💾 Settings auto-saved to ${this.settingsFile}`));
    } catch (error) {
      console.log(
        chalk.red(`❌ Failed to auto-save settings: ${error.message}`),
      );
    }
  }

  initializeClients() {
    this.clients = this.config.tokens.map((tokenObj) => {
      // Handle both old format (string) and new format (object)
      if (typeof tokenObj === "string") {
        const client = new WhiskClient(tokenObj);
        client.name = `Unnamed Token`;
        return client;
      } else {
        // Create client with the token value
        const client = new WhiskClient(tokenObj.token);
        // Add the name to the client for reference
        client.name = tokenObj.name;
        return client;
      }
    });
    this.currentTokenIndex = 0;
  }

  getNextClient() {
    if (this.clients.length === 0) return null;

    const client = this.clients[this.currentTokenIndex];
    this.currentTokenIndex = (this.currentTokenIndex + 1) % this.clients.length;

    // Ensure the client has a name property
    if (!client.name) {
      client.name = `Token ${this.currentTokenIndex + 1}`;
    }

    return client;
  }

  async ensureOutputDir() {
    try {
      await fs.access(this.config.outputDir);
    } catch {
      await fs.mkdir(this.config.outputDir, { recursive: true });
      console.log(
        chalk.green(`📁 Created output directory: ${this.config.outputDir}`),
      );
    }
  }

  async loadPromptsFromFile(filePath) {
    try {
      // Check if file exists first
      await fs.access(filePath);

      const content = await fs.readFile(filePath, "utf-8");
      const prompts = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));

      this.config.promptFile = filePath;
      console.log(
        chalk.green(
          `✓ Successfully loaded ${prompts.length} prompts from ${filePath}`,
        ),
      );
      return prompts;
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`File not found: ${filePath}`);
      }
      throw new Error(`Failed to load prompts file: ${error.message}`);
    }
  }

  async removePromptFromFile(filePath, promptToRemove) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const filteredLines = lines.filter(
        (line) => line.trim() !== promptToRemove.trim() || line.startsWith("#"),
      );
      await fs.writeFile(filePath, filteredLines.join("\n"));
      return true;
    } catch (error) {
      console.log(
        chalk.yellow(
          `⚠️  Warning: Could not remove prompt from file: ${error.message}`,
        ),
      );
      return false;
    }
  }

  async compressImage(inputBuffer, quality) {
    try {
      return await sharp(inputBuffer).jpeg({ quality }).toBuffer();
    } catch (error) {
      console.log(
        chalk.yellow(`⚠️  Warning: Could not compress image: ${error.message}`),
      );
      return inputBuffer;
    }
  }

  async saveImage(imageData, fileName, compress = false) {
    try {
      await this.ensureOutputDir();

      const buffer = Buffer.from(imageData, "base64");
      const finalBuffer = compress
        ? await this.compressImage(buffer, this.config.compression)
        : buffer;

      const filePath = path.join(this.config.outputDir, fileName);
      await fs.writeFile(filePath, finalBuffer);

      const stats = await fs.stat(filePath);
      const sizeKB = (stats.size / 1024).toFixed(1);

      console.log(chalk.green(`✓ Saved: ${fileName} (${sizeKB}KB)`));
      return filePath;
    } catch (error) {
      throw new Error(`Failed to save image: ${error.message}`);
    }
  }

  getAspectRatioOptions() {
    return {
      "landscape-16:9": {
        code: "IMAGE_ASPECT_RATIO_LANDSCAPE",
        display: "landscape (16:9)",
        description: "Standard widescreen landscape",
      },
      "landscape-4:3": {
        code: "IMAGE_ASPECT_RATIO_WIDE",
        display: "landscape (4:3)",
        description: "Traditional landscape",
      },
      "portrait-9:16": {
        code: "IMAGE_ASPECT_RATIO_PORTRAIT",
        display: "portrait (9:16)",
        description: "Tall portrait format",
      },
      "portrait-3:4": {
        code: "IMAGE_ASPECT_RATIO_TALL",
        display: "portrait (3:4)",
        description: "Traditional portrait",
      },
      "square-1:1": {
        code: "IMAGE_ASPECT_RATIO_SQUARE",
        display: "square (1:1)",
        description: "Perfect square format",
      },
    };
  }

  getRandomAspectRatio() {
    const aspectOptions = this.getAspectRatioOptions();
    const keys = Object.keys(aspectOptions);
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    return aspectOptions[randomKey];
  }

  async promptUser(question) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  displayMainMenu() {
    console.clear();
    console.log(chalk.blue.bold("\n🎨 Whisk AI Image Generator\n"));

    // Config Summary
    console.log(chalk.cyan.bold("📋 Current Configuration:"));
    console.log(chalk.gray("━".repeat(50)));

    const tokenCount = this.config.tokens.length;
    const tokenStatus =
      tokenCount > 0
        ? `${tokenCount} token(s) ${chalk.green("✓")}`
        : `${chalk.red("❌ Not set")}`;
    console.log(`${chalk.cyan("API Tokens:")} ${tokenStatus}`);

    console.log(`${chalk.cyan("Output Dir:")} ${this.config.outputDir}`);

    const promptFileStatus = this.config.promptFile
      ? `${path.basename(this.config.promptFile)} ${chalk.green("✓")}`
      : `${chalk.red("❌ Not set")}`;
    console.log(`${chalk.cyan("Prompt File:")} ${promptFileStatus}`);

    const aspectDisplay = this.config.randomAspectRatio
      ? `${chalk.magenta("🎲 Random")}`
      : this.config.aspectRatioDisplay;
    console.log(`${chalk.cyan("Aspect Ratio:")} ${aspectDisplay}`);

    console.log(`${chalk.cyan("Image Quality:")} ${this.config.compression}%`);
    console.log(`${chalk.cyan("Workers:")} ${this.config.workers}`);

    console.log(chalk.gray("━".repeat(50)));

    console.log(chalk.cyan("\n📋 Main Menu:"));
    console.log("1. 🔑 Manage API Tokens");
    console.log("2. ⚙️  Configure Settings");
    console.log("3. 📝 Set Prompt File");
    console.log("4. 🚀 Generate Images");
    console.log("5. 📊 View Status");
    console.log("6. ❌ Exit");
  }

  async showMainMenu() {
    this.displayMainMenu();
    const choice = await this.promptUser("\nSelect option (1-6): ");
    return choice;
  }

  async showTokenMenu() {
    console.clear();
    console.log(chalk.blue.bold("\n🔑 Token Management\n"));

    const tokenCount = this.config.tokens.length;
    if (tokenCount > 0) {
      console.log(
        chalk.green(`Currently configured: ${tokenCount} token(s)\n`),
      );
    } else {
      console.log(
        chalk.yellow(
          "⚠️  No tokens configured - required for image generation!\n",
        ),
      );
    }

    console.log(chalk.cyan("Token Menu:"));
    console.log("1. ➕ Add New Token");
    console.log("2. 📋 View Current Tokens");
    console.log("3. 🗑️  Remove Token");
    console.log("4. 🧹 Clear All Tokens");
    console.log("5. 🔙 Back to Main Menu");

    const choice = await this.promptUser("\nSelect option (1-5): ");
    return choice;
  }

  async showSettingsMenu() {
    console.clear();
    console.log(chalk.blue.bold("\n⚙️  Settings Configuration\n"));

    console.log(chalk.cyan("Current Settings:"));
    console.log(chalk.gray("─".repeat(40)));
    console.log(`📁 Output Directory: ${this.config.outputDir}`);
    const aspectDisplay = this.config.randomAspectRatio
      ? `🎲 Random Aspect Ratio`
      : `📐 Fixed: ${this.config.aspectRatioDisplay}`;
    console.log(`${aspectDisplay}`);
    console.log(`🗜️  Image Quality: ${this.config.compression}%`);
    console.log(`👥 Workers: ${this.config.workers}`);
    console.log(`⏱️  API Request Delay: ${this.config.requestDelay}ms`);
    console.log(chalk.gray("─".repeat(40)));

    console.log(chalk.cyan("\nSettings Menu:"));
    console.log("1. 📁 Change Output Directory");
    console.log("2. 📐 Configure Aspect Ratio");
    console.log("3. 🗜️  Change Image Quality");
    console.log("4. 👥 Change Number of Workers");
    console.log("5. ⏱️  Configure API Request Delay");
    console.log("6. 🔙 Back to Main Menu");

    const choice = await this.promptUser("\nSelect option (1-6): ");
    return choice;
  }

  async handleTokenManagement() {
    while (true) {
      const choice = await this.showTokenMenu();

      switch (choice) {
        case "1":
          await this.addToken();
          break;
        case "2":
          await this.viewTokens();
          break;
        case "3":
          await this.removeToken();
          break;
        case "4":
          await this.clearAllTokens();
          break;
        case "5":
          return;
        default:
          console.log(chalk.red("❌ Invalid option. Please select 1-5."));
          await this.promptUser("⏎ Press Enter to continue...");
      }
    }
  }

  async addToken() {
    console.clear();
    console.log(chalk.blue.bold("\n➕ Add New Token\n"));
    console.log(
      chalk.yellow(
        "💡 Tip: You can add multiple tokens for faster generation with multiple workers.",
      ),
    );

    const token = await this.promptUser("\nEnter your Whisk API token: ");
    if (!token) {
      console.log(chalk.yellow("⚠️  No token provided. Operation cancelled."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    // Check if token already exists
    if (this.config.tokens.some((t) => t.token === token)) {
      console.log(chalk.yellow("⚠️  Token already exists in configuration."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    const tokenName = await this.promptUser(
      "\nEnter a name for this token (for identification): ",
    );
    const name = tokenName || `Token ${this.config.tokens.length + 1}`;

    // Test token validity (basic check)
    const testSpinner = ora("🔍 Testing token validity...").start();
    try {
      const testClient = new WhiskClient(token);
      await testClient.checkCredentials();
      testSpinner.succeed("\n✅ Token format is valid\n");
    } catch (error) {
      testSpinner.fail(`\n❌ Token validation failed:
⚠️ Error: ${error.message}\n`);
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    // Add token with name
    this.config.tokens.push({ name, token });
    this.initializeClients();
    await this.autoSaveSettings();

    console.log(
      chalk.green(
        `✅ Token "${name}" added successfully! Total tokens: ${this.config.tokens.length}`,
      ),
    );
    console.log(
      chalk.blue(
        `💡 You can now use ${this.config.tokens.length} worker(s) for parallel generation.`,
      ),
    );

    await this.promptUser("⏎ Press Enter to continue...");
  }

  async viewTokens() {
    console.clear();
    console.log(chalk.blue.bold("\n📋 Current Tokens\n"));

    if (this.config.tokens.length === 0) {
      console.log(chalk.yellow("No tokens configured."));
      console.log(
        chalk.blue(
          "\n💡 Tip: Add at least one token to start generating images.",
        ),
      );
    } else {
      console.log(
        chalk.green(`Total configured tokens: ${this.config.tokens.length}\n`),
      );
      this.config.tokens.forEach((tokenObj, index) => {
        const token = tokenObj.token;
        const name = tokenObj.name;
        const masked = `${token.substring(0, 10)}${"*".repeat(Math.max(0, token.length - 20))}${token.length > 10 ? token.substring(token.length - 10) : ""}`;
        console.log(
          `${chalk.cyan(`${index + 1}.`)} [${chalk.yellow(name)}] ${masked}`,
        );
      });
      console.log(
        chalk.blue(
          `\n💡 With ${this.config.tokens.length} token(s), you can run up to ${this.config.tokens.length} parallel worker(s).`,
        ),
      );
    }

    await this.promptUser("\n⏎ Press Enter to continue...");
  }

  async removeToken() {
    console.clear();
    console.log(chalk.blue.bold("\n🗑️  Remove Token\n"));

    if (this.config.tokens.length === 0) {
      console.log(chalk.yellow("No tokens available to remove."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    console.log("Select token to remove:");
    this.config.tokens.forEach((tokenObj, index) => {
      const token = tokenObj.token;
      const name = tokenObj.name;
      const masked = `${token.substring(0, 10)}${"*".repeat(Math.max(0, token.length - 20))}${token.length > 10 ? token.substring(token.length - 10) : ""}`;
      console.log(`${index + 1}. [${chalk.yellow(name)}] ${masked}`);
    });

    const choice = await this.promptUser(
      "\nEnter token number (or 0 to cancel): ",
    );

    if (choice === "0") {
      console.log(chalk.yellow("Operation cancelled."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    const tokenIndex = parseInt(choice) - 1;

    if (
      isNaN(tokenIndex) ||
      tokenIndex < 0 ||
      tokenIndex >= this.config.tokens.length
    ) {
      console.log(
        chalk.red("❌ Invalid selection. Please enter a valid number."),
      );
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    const selectedToken = this.config.tokens[tokenIndex];

    this.config.tokens.splice(tokenIndex, 1);
    this.initializeClients();
    await this.autoSaveSettings();
    console.log(
      chalk.green(`✅ Token "${selectedToken.name}" removed successfully.`),
    );
    console.log(chalk.blue(`Remaining tokens: ${this.config.tokens.length}`));

    await this.promptUser("⏎ Press Enter to continue...");
  }

  async clearAllTokens() {
    console.clear();
    console.log(chalk.blue.bold("\n🧹 Clear All Tokens\n"));

    if (this.config.tokens.length === 0) {
      console.log(chalk.yellow("No tokens to clear."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    // List tokens that will be removed
    console.log(
      chalk.yellow(
        `⚠️  This will remove all ${this.config.tokens.length} configured tokens:`,
      ),
    );
    this.config.tokens.forEach((tokenObj, index) => {
      console.log(`  ${index + 1}. ${chalk.yellow(tokenObj.name)}`);
    });

    const confirm = await this.promptUser(
      `\nAre you sure you want to clear all tokens? (y/N): `,
    );

    if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
      console.log(chalk.yellow("Operation cancelled."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    this.config.tokens = [];
    this.clients = [];
    await this.autoSaveSettings();

    console.log(chalk.green("✅ All tokens cleared successfully!"));
    await this.promptUser("⏎ Press Enter to continue...");
  }

  async handleSettingsConfiguration() {
    let choice = "0";
    while (choice !== "6") {
      choice = await this.showSettingsMenu();
      switch (choice) {
        case "1":
          await this.configureOutputDirectory();
          break;
        case "2":
          await this.configureAspectRatio();
          break;
        case "3":
          await this.configureCompression();
          break;
        case "4":
          await this.configureWorkers();
          break;
        case "5":
          await this.configureRequestDelay();
          break;
        case "6":
          return;
        default:
          console.log(chalk.yellow("Invalid option. Please try again."));
          await this.promptUser("⏎ Press Enter to continue...");
      }
    }
  }

  async configureOutputDirectory() {
    console.clear();
    console.log(chalk.blue.bold("\n📁 Output Directory Configuration\n"));
    console.log(chalk.cyan(`Current directory: ${this.config.outputDir}`));

    // Check if current directory exists and show info
    try {
      await fs.access(this.config.outputDir);
      const files = await fs.readdir(this.config.outputDir);
      const imageFiles = files.filter((f) =>
        f.toLowerCase().match(/\.(jpg|jpeg|png|webp)$/),
      );
      console.log(
        chalk.green(
          `✓ Directory exists (${imageFiles.length} image files found)`,
        ),
      );
    } catch {
      console.log(
        chalk.yellow(
          "⚠️  Directory does not exist (will be created automatically)",
        ),
      );
    }

    const newDir = await this.promptUser(
      "\nEnter new output directory (or press Enter to keep current): ",
    );

    if (!newDir) {
      console.log(chalk.yellow("Directory unchanged."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    const oldDir = this.config.outputDir;
    this.config.outputDir = newDir;
    await this.autoSaveSettings();

    console.log(chalk.green("✅ Output directory updated successfully!"));
    console.log(chalk.blue(`Changed from: ${oldDir}`));
    console.log(chalk.blue(`Changed to: ${newDir}`));

    await this.promptUser("⏎ Press Enter to continue...");
  }

  async configureAspectRatio() {
    console.clear();
    console.log(chalk.blue.bold("\n📐 Aspect Ratio Configuration\n"));

    const aspectOptions = this.getAspectRatioOptions();
    const currentDisplay = this.config.randomAspectRatio
      ? "🎲 Random Aspect Ratio"
      : this.config.aspectRatioDisplay;
    console.log(chalk.cyan(`Current setting: ${currentDisplay}\n`));

    console.log("Available options:");
    console.log("  0. 🎲 Random aspect ratio (different for each image)");
    Object.entries(aspectOptions).forEach(([key, value], i) => {
      console.log(`  ${i + 1}. ${value.display} - ${value.description}`);
    });

    const choice = await this.promptUser(
      "\nChoose aspect ratio (0-5, or press Enter to keep current): ",
    );

    if (!choice) {
      console.log(chalk.yellow("Aspect ratio unchanged."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    const choiceNum = parseInt(choice);
    if (isNaN(choiceNum) || choiceNum < 0 || choiceNum > 5) {
      console.log(chalk.red("❌ Invalid selection. Please enter 0-5."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    if (choiceNum === 0) {
      this.config.randomAspectRatio = true;
      this.config.aspectRatio = "IMAGE_ASPECT_RATIO_LANDSCAPE"; // default fallback
      this.config.aspectRatioDisplay = "Random";
      console.log(
        chalk.green(
          "✅ Set to random aspect ratio! Each image will use a different aspect ratio.",
        ),
      );
    } else {
      const aspectKeys = Object.keys(aspectOptions);
      const aspectIndex = choiceNum - 1;
      const selectedKey = aspectKeys[aspectIndex];
      this.config.randomAspectRatio = false;
      this.config.aspectRatio = aspectOptions[selectedKey].code;
      this.config.aspectRatioDisplay = aspectOptions[selectedKey].display;
      console.log(
        chalk.green(
          `✅ Aspect ratio set to: ${aspectOptions[selectedKey].display}`,
        ),
      );
    }

    await this.autoSaveSettings();
    await this.promptUser("⏎ Press Enter to continue...");
  }

  async configureCompression() {
    console.clear();
    console.log(chalk.blue.bold("\n🗜️  Image Quality Configuration\n"));
    console.log(chalk.cyan(`Current quality: ${this.config.compression}%`));
    console.log(
      chalk.yellow(
        "💡 Higher quality = larger file size, lower quality = smaller file size",
      ),
    );
    console.log(chalk.gray("   Recommended: 80-95% for good balance"));

    const compression = await this.promptUser(
      "\nEnter quality percentage 1-100% (or press Enter to keep current): ",
    );

    if (!compression) {
      console.log(chalk.yellow("Quality setting unchanged."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    const compressionNum = parseInt(compression);
    if (isNaN(compressionNum) || compressionNum < 1 || compressionNum > 100) {
      console.log(
        chalk.red(
          "❌ Invalid quality value. Please enter a number between 1-100.",
        ),
      );
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    const oldQuality = this.config.compression;
    this.config.compression = compressionNum;
    await this.autoSaveSettings();

    console.log(chalk.green("✅ Image quality updated successfully!"));
    console.log(
      chalk.blue(`Changed from: ${oldQuality}% to ${compressionNum}%`),
    );

    if (compressionNum >= 95) {
      console.log(
        chalk.yellow("💡 Very high quality - expect larger file sizes"),
      );
    } else if (compressionNum <= 50) {
      console.log(
        chalk.yellow(
          "💡 Low quality - files will be small but may show compression artifacts",
        ),
      );
    }

    await this.promptUser("⏎ Press Enter to continue...");
  }

  async configureWorkers() {
    console.clear();
    console.log(chalk.blue.bold("\n👥 Workers Configuration\n"));
    console.log(chalk.cyan(`Current workers: ${this.config.workers}`));
    console.log(
      chalk.cyan(
        `Available tokens: ${this.config.tokens.length} (${this.config.tokens.map((t) => t.name).join(", ")})`,
      ),
    );

    if (this.config.tokens.length === 0) {
      console.log(
        chalk.yellow(
          "⚠️  No tokens configured! Add tokens first before setting workers.",
        ),
      );
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    console.log(
      chalk.yellow(
        `💡 Recommended: Use up to ${this.config.tokens.length} worker(s) (one per token)`,
      ),
    );
    console.log(
      chalk.gray(
        "   More workers = faster generation (if you have multiple tokens)",
      ),
    );

    const workers = await this.promptUser(
      "\nEnter number of workers 1-10 (or press Enter to keep current): ",
    );

    if (!workers) {
      console.log(chalk.yellow("Workers setting unchanged."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    const workersNum = parseInt(workers);
    if (isNaN(workersNum) || workersNum < 1 || workersNum > 10) {
      console.log(
        chalk.red(
          "❌ Invalid workers count. Please enter a number between 1-10.",
        ),
      );
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    const oldWorkers = this.config.workers;
    this.config.workers = workersNum;
    await this.autoSaveSettings();

    console.log(chalk.green("✅ Workers count updated successfully!"));
    console.log(
      chalk.blue(`Changed from: ${oldWorkers} to ${workersNum} worker(s)`),
    );

    if (workersNum > this.config.tokens.length) {
      console.log(
        chalk.yellow(
          `⚠️  You have more workers (${workersNum}) than tokens (${this.config.tokens.length})`,
        ),
      );
      console.log(
        chalk.yellow("   Workers will share tokens, which may be slower"),
      );
    }

    await this.promptUser("⏎ Press Enter to continue...");
  }

  async configureRequestDelay() {
    console.clear();
    console.log(chalk.blue.bold("\n⏱️  API Request Delay Configuration\n"));
    console.log(chalk.cyan(`Current delay: ${this.config.requestDelay}ms`));

    console.log(
      chalk.yellow(
        "💡 Higher delay = more respectful to API but slower generation",
      ),
    );
    console.log(
      chalk.gray(
        "   Recommended: 1000ms (1 second) between requests per worker",
      ),
    );
    console.log(
      chalk.gray(
        "   Minimum: 0ms (no delay) - use only if approved by API provider",
      ),
    );
    console.log(chalk.gray("   Maximum: 10000ms (10 seconds)"));

    const delay = await this.promptUser(
      "\nEnter delay in milliseconds (0-10000) or press Enter to keep current: ",
    );

    if (!delay) {
      console.log(chalk.yellow("API request delay unchanged."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    const delayNum = parseInt(delay);
    if (isNaN(delayNum) || delayNum < 0 || delayNum > 10000) {
      console.log(
        chalk.red("❌ Invalid delay. Please enter a number between 0-10000."),
      );
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    const oldDelay = this.config.requestDelay;
    this.config.requestDelay = delayNum;
    await this.autoSaveSettings();

    console.log(chalk.green("✅ API request delay updated successfully!"));
    console.log(chalk.blue(`Changed from: ${oldDelay}ms to ${delayNum}ms`));

    await this.promptUser("⏎ Press Enter to continue...");
  }

  async setPromptFile() {
    console.clear();
    console.log(chalk.blue.bold("\n📝 Set Prompt File\n"));

    if (this.config.promptFile) {
      console.log(chalk.cyan(`Current file: ${this.config.promptFile}`));

      // Check current file status
      try {
        const content = await fs.readFile(this.config.promptFile, "utf-8");
        const prompts = content
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("#"));
        console.log(
          chalk.green(`✓ File exists (${prompts.length} prompts found)`),
        );
      } catch {
        console.log(chalk.red("❌ File no longer exists or is not accessible"));
      }
    } else {
      console.log(chalk.yellow("No prompt file currently set"));
    }

    console.log(
      chalk.yellow("\n💡 Tip: Create a .txt file with one prompt per line"),
    );
    console.log(chalk.gray("   Lines starting with # are ignored (comments)"));
    console.log(
      chalk.gray(
        "   Completed prompts will be automatically removed from the file",
      ),
    );

    const filePath = await this.promptUser(
      "\nEnter prompt file path (or press Enter to keep current): ",
    );

    if (!filePath) {
      console.log(chalk.yellow("Prompt file unchanged."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    try {
      const prompts = await this.loadPromptsFromFile(filePath);
      await this.autoSaveSettings();

      console.log(chalk.green("✅ Prompt file set successfully!"));
      console.log(chalk.blue(`File: ${filePath}`));
      console.log(chalk.blue(`Prompts loaded: ${prompts.length}`));

      if (prompts.length === 0) {
        console.log(
          chalk.yellow("⚠️  File is empty or contains no valid prompts"),
        );
      }
    } catch (error) {
      console.log(chalk.red(`❌ ${error.message}`));
    }

    await this.promptUser("⏎ Press Enter to continue...");
  }

  async viewStatus() {
    console.clear();
    console.log(chalk.blue.bold("\n📊 System Status\n"));

    // Configuration Status
    console.log(chalk.cyan.bold("🔧 Configuration Status:"));
    console.log(chalk.gray("━".repeat(50)));

    // Tokens
    const tokenStatus =
      this.config.tokens.length > 0
        ? `${chalk.green("✓")} ${this.config.tokens.length} token(s) configured`
        : `${chalk.red("❌")} No tokens configured`;
    console.log(`🔑 API Tokens: ${tokenStatus}`);

    // Prompt file
    let promptStatus = `${chalk.red("❌")} No prompt file set`;
    let promptCount = 0;

    if (this.config.promptFile) {
      try {
        const content = await fs.readFile(this.config.promptFile, "utf-8");
        const prompts = content
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("#"));
        promptCount = prompts.length;

        if (promptCount > 0) {
          promptStatus = `${chalk.green("✓")} ${promptCount} prompts ready`;
        } else {
          promptStatus = `${chalk.yellow("⚠️")} File empty`;
        }
      } catch {
        promptStatus = `${chalk.red("❌")} File not accessible`;
      }
    }
    console.log(`📝 Prompt File: ${promptStatus}`);

    // Output directory
    let outputStatus = `${chalk.red("❌")} Directory not accessible`;
    let imageCount = 0;

    try {
      await fs.access(this.config.outputDir);
      const files = await fs.readdir(this.config.outputDir);
      imageCount = files.filter((f) =>
        f.toLowerCase().match(/\.(jpg|jpeg|png|webp)$/),
      ).length;
      outputStatus = `${chalk.green("✓")} Directory exists (${imageCount} images)`;
    } catch {
      outputStatus = `${chalk.yellow("⚠️")} Will be created when needed`;
    }
    console.log(`📁 Output Dir: ${outputStatus}`);

    console.log(chalk.gray("━".repeat(50)));

    // Current Settings
    console.log(chalk.cyan.bold("\n⚙️ Current Settings:"));
    console.log(chalk.gray("━".repeat(50)));
    console.log(
      `📐 Aspect Ratio: ${this.config.randomAspectRatio ? "🎲 Random" : this.config.aspectRatioDisplay}`,
    );
    console.log(`🗜️  Image Quality: ${this.config.compression}%`);
    console.log(`👥 Workers: ${this.config.workers}`);
    console.log(`⏱️  API Request Delay: ${this.config.requestDelay}ms`);
    console.log(chalk.gray("━".repeat(50)));

    // Ready to generate?
    const canGenerate =
      this.config.tokens.length > 0 &&
      this.config.promptFile &&
      promptCount > 0;
    console.log(chalk.cyan.bold("\n🚀 Generation Readiness:"));
    console.log(chalk.gray("━".repeat(50)));

    if (canGenerate) {
      console.log(chalk.green.bold("✅ Ready to generate images!"));
      console.log(
        chalk.blue(
          `🎯 Will process ${promptCount} prompts using ${this.config.workers} worker(s)`,
        ),
      );

      if (this.config.workers > this.config.tokens.length) {
        console.log(
          chalk.yellow(
            `⚠️  More workers than tokens - some workers will share tokens`,
          ),
        );
      }
    } else {
      console.log(chalk.red.bold("❌ Not ready to generate"));
      console.log(chalk.yellow("\nMissing requirements:"));

      if (this.config.tokens.length === 0) {
        console.log("  • Configure at least one API token");
      }
      if (!this.config.promptFile || promptCount === 0) {
        console.log("  • Set a prompt file with valid prompts");
      }
    }

    await this.promptUser("\n⏎ Press Enter to continue...");
  }

  async generateImagesWorker(prompts, workerId, totalWorkers) {
    const results = {
      success: 0,
      failed: 0,
      images: [],
      completedPrompts: [],
      failedPrompts: [],
    };

    // Track consecutive prompts with 429/401 errors for this worker
    let consecutivePromptErrors = 0;
    const MAX_CONSECUTIVE_PROMPT_ERRORS = 3;

    // Calculate total prompts count for tracking progress
    const totalPromptsForThisWorker = prompts.length;

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];

      // Get aspect ratio for this image
      let aspectRatio = this.config.aspectRatio;
      let aspectDisplay = this.config.aspectRatioDisplay;

      if (this.config.randomAspectRatio) {
        const randomAspect = this.getRandomAspectRatio();
        aspectRatio = randomAspect.code;
        aspectDisplay = randomAspect.display;
      }

      // Format worker ID and prompt display
      const workerId_display = `Worker ${workerId + 1}`;
      // Calculate the current prompt position
      const promptPosition = i + 1;

      // Simple spinner with consistent format
      const promptPreview =
        prompt.substring(0, 40) + (prompt.length > 40 ? "..." : "");
      const spinner = ora(
        `${workerId_display}: [${promptPosition}/${totalPromptsForThisWorker}] ${aspectDisplay} - "${promptPreview}"`,
      ).start();

      // Get client for this job
      const client = this.getNextClient();

      let success = false;
      let attempts = 0;
      const maxAttempts = this.clients.length > 0 ? this.clients.length : 1;
      let promptHadApiError = false; // Track if this prompt had a 429/401 error

      while (!success && attempts < maxAttempts) {
        // Get a client for this attempt
        const client = this.getNextClient();

        if (!client) {
          spinner.fail(`\n\n${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): ❌ ERROR - No valid tokens available
💬 Prompt: "${promptPreview}"\n`);
          results.failed++;
          break;
        }

        // Update spinner with retry information if this isn't the first attempt
        if (attempts > 0) {
          spinner.text = `${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): Retrying with token "${client.name}"... (${attempts + 1}/${maxAttempts})`;
        }

        try {
          // Show which token is being used (first attempt)
          if (attempts === 0) {
            spinner.text = `${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): Generating with token "${client.name}"...`;
          }

          const result = await client.generateImage({
            prompt: prompt,
            aspectRatio: aspectRatio,
            seed: Math.floor(Math.random() * 1000000),
          });

          // Update spinner to show we got a response
          spinner.text = `${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): Response received from token "${client.name}"`;

          if (result.Err) {
            attempts++;
            
            // Check if this is a 429 error (rate limit) or 401 error (unauthorized)
            if (result.Err.message && (result.Err.message.includes("429") || result.Err.message.includes("401"))) {
              const errorType = result.Err.message.includes("429") ? "Rate limit error (429)" : "Unauthorized error (401)";
              spinner.text = `${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): ${errorType}`;
              promptHadApiError = true;
            }
            
            if (attempts >= maxAttempts) {
              const promptPreviewShort =
                prompt.substring(0, 35) + (prompt.length > 35 ? "..." : "");
              spinner.fail(
                `\n\n${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): ❌ FAILED - All tokens attempted
⚠️ Error: ${result.Err.message}
💬 Prompt: "${promptPreviewShort}"\n`,
              );
              results.failed++;
              results.failedPrompts.push(prompt);
            } else {
              spinner.text = `${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): Retrying with different token... (${attempts + 1}/${maxAttempts})`;
            }
            continue;
          }

          const imagePanel = result.Ok?.imagePanels;
          if (!imagePanel || imagePanel.length === 0) {
            attempts++;
            if (attempts >= maxAttempts) {
              const promptPreviewShort =
                prompt.substring(0, 35) + (prompt.length > 35 ? "..." : "");
              spinner.fail(
                `\n\n${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): ❌ FAILED - No images generated with any token
💬 Prompt: "${promptPreviewShort}"\n`,
              );
              results.failed++;
              results.failedPrompts.push(prompt);
            } else {
              spinner.text = `${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): No images returned, retrying... (${attempts + 1}/${maxAttempts})`;
            }
            continue;
          }

          let savedCount = 0;
          for (const panel of imagePanel) {
            for (const image of panel.generatedImages || []) {
              const timestamp = Date.now();
              const aspectShort = aspectDisplay.split(" ")[0]; // e.g., "landscape", "portrait", "square"
              const fileName = `w${(workerId + 1).toString().padStart(2, "0")}_${timestamp}_${aspectShort}_${savedCount + 1}.jpg`;

              // Update spinner to show we're saving the image
              spinner.text = `${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): Saving image ${savedCount + 1}...`;

              const filePath = await this.saveImage(
                image.encodedImage,
                fileName,
                this.config.compression < 100,
              );
              results.images.push(filePath);
              savedCount++;

              // Show file saved status in the spinner text
              let fileSize = 0;
              try {
                const stats = fsSync.statSync(filePath);
                fileSize = stats.size;
              } catch (error) {
                console.log(
                  chalk.yellow(
                    `⚠️  Warning: Could not get file size: ${error.message}`,
                  ),
                );
              }
              const fileSizeDisplay = (fileSize / 1024).toFixed(1) + "KB";
              spinner.text = `${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): Saved: ${fileName} (${fileSizeDisplay})`;
            }
          }

          // Remove this prompt from the file immediately after successful generation
          const removed = await this.removePromptFromFile(
            this.config.promptFile,
            prompt,
          );

          // Complete the spinner with a multi-line structured success message
          const promptPreviewShort =
            prompt.substring(0, 35) + (prompt.length > 35 ? "..." : "");
          const removeMsg = removed ? "\n🗑️ Prompt removed from file" : "";
          spinner.succeed(
            `\n\n${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): ✅ SUCCESS | Generated ${savedCount} image(s)
🔑 Token: "${client.name}"
📐 Format: ${aspectDisplay}
💬 Prompt: "${promptPreviewShort}"${removeMsg}`,
          );
          results.success += savedCount;
          results.completedPrompts.push(prompt);
          success = true;
          // This prompt was successful, reset flag
          promptHadApiError = false;
        } catch (error) {
          attempts++;
          
          // Check if this is a 429 error (rate limit) or 401 error (unauthorized)
          if (error.message && (error.message.includes("429") || error.message.includes("401"))) {
            const errorType = error.message.includes("429") ? "Rate limit error (429)" : "Unauthorized error (401)";
            spinner.text = `${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): ${errorType}`;
            promptHadApiError = true;
          }
          
          if (attempts >= maxAttempts) {
            const promptPreviewShort =
              prompt.substring(0, 35) + (prompt.length > 35 ? "..." : "");
            spinner.fail(
              `\n\n${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): ❌ ERROR - All tokens failed
⚠️ Error: ${error.message}
💬 Prompt: "${promptPreviewShort}"\n`,
            );
            results.failed++;
            results.failedPrompts.push(prompt);
          } else {
            spinner.text = `${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): Network error, retrying... (${attempts + 1}/${maxAttempts})`;
          }
        }
      }

      // Check if this prompt had a 429/401 error
      if (promptHadApiError) {
        consecutivePromptErrors++;
        
        // Log the consecutive errors
        console.log(
          chalk.yellow(
            `${workerId_display}: ⚠️ ${consecutivePromptErrors}/${MAX_CONSECUTIVE_PROMPT_ERRORS} consecutive prompts with API errors (429/401)`,
          ),
        );
        
        // Stop the worker if we've hit too many consecutive prompts with API errors
        if (consecutivePromptErrors >= MAX_CONSECUTIVE_PROMPT_ERRORS) {
          const promptPreviewShort =
            prompt.substring(0, 35) + (prompt.length > 35 ? "..." : "");
          console.log(
            chalk.red(
              `\n\n${workerId_display}: ❌ STOPPING WORKER - ${MAX_CONSECUTIVE_PROMPT_ERRORS} consecutive prompts with API errors (429/401)
⚠️ All tokens appear to be rate-limited or unauthorized
💬 Last prompt: "${promptPreviewShort}"\n`,
            ),
          );
          
          // Add remaining prompts to failedPrompts list
          for (let j = i + 1; j < prompts.length; j++) {
            results.failedPrompts.push(prompts[j]);
            results.failed++;
          }
          
          // Exit the loop to stop processing
          return results;
        }
      } else {
        // Reset counter on successful prompt
        consecutivePromptErrors = 0;
      }
      
      // Add delay between requests for same worker to be respectful to the API
      if (i < prompts.length - 1) {
        // Show waiting message if delay is significant
        if (this.config.requestDelay >= 1000) {
          const delaySeconds = (this.config.requestDelay / 1000).toFixed(1);
          console.log(
            chalk.dim(
              `${workerId_display} (${promptPosition}/${totalPromptsForThisWorker}): ⏱️ Waiting ${delaySeconds}s before next prompt...\n`,
            ),
          );
          await new Promise((resolve) =>
            setTimeout(resolve, this.config.requestDelay),
          );
        } else {
          await new Promise((resolve) =>
            setTimeout(resolve, this.config.requestDelay),
          );
        }
      }
    }

    return results;
  }

  async removeCompletedPromptsFromFile(completedPrompts) {
    if (!this.config.promptFile || completedPrompts.length === 0) return false;

    let success = true;
    for (const prompt of completedPrompts) {
      const removed = await this.removePromptFromFile(
        this.config.promptFile,
        prompt,
      );
      if (!removed) success = false;
    }

    if (success) {
      console.log(
        chalk.green(`📝 All completed prompts have been removed from file`),
      );
    } else {
      console.log(
        chalk.yellow(
          `⚠️  Warning: Some prompts could not be removed from file`,
        ),
      );
    }

    return success;
  }

  async generateImages() {
    console.clear();
    console.log(chalk.blue.bold("\n🚀 Image Generation\n"));

    // Load current prompts from file
    let currentPrompts = [];
    if (this.config.promptFile) {
      try {
        currentPrompts = await this.loadPromptsFromFile(this.config.promptFile);
      } catch (error) {
        console.log(chalk.red(`❌ ${error.message}`));
        await this.promptUser("⏎ Press Enter to continue...");
        return;
      }
    }

    // Check prerequisites
    if (this.config.tokens.length === 0) {
      console.log(
        chalk.red("❌ No API tokens configured! Please add tokens first."),
      );
      console.log(
        chalk.blue(
          "💡 Go to: Main Menu → 1. Manage API Tokens → 1. Add New Token",
        ),
      );
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    if (currentPrompts.length === 0) {
      console.log(
        chalk.red(
          "❌ No prompts available! Please set a prompt file with valid prompts.",
        ),
      );
      console.log(chalk.blue("💡 Go to: Main Menu → 3. Set Prompt File"));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    // Display generation info
    console.log(chalk.cyan.bold("📋 Generation Configuration:"));
    console.log(chalk.gray("━".repeat(50)));
    console.log(`🔑 API Tokens: ${this.config.tokens.length}`);
    console.log(`📝 Prompts: ${currentPrompts.length}`);
    console.log(`👥 Workers: ${this.config.workers}`);
    console.log(`⏱️  API Request Delay: ${this.config.requestDelay}ms`);
    console.log(
      `📐 Aspect Ratio: ${this.config.randomAspectRatio ? "🎲 Random" : this.config.aspectRatioDisplay}`,
    );
    console.log(`🗜️  Image Quality: ${this.config.compression}%`);
    console.log(`📁 Output Directory: ${this.config.outputDir}`);
    console.log(`📄 Prompt File: ${path.basename(this.config.promptFile)}`);
    console.log(chalk.gray("━".repeat(50)));

    // Show warnings if any
    if (this.config.workers > this.config.tokens.length) {
      console.log(
        chalk.yellow(
          `⚠️  You have more workers (${this.config.workers}) than tokens (${this.config.tokens.length})`,
        ),
      );
      console.log(
        chalk.yellow(
          "   Some workers will share tokens, which may slow down generation",
        ),
      );
    }

    if (this.config.randomAspectRatio) {
      console.log(
        chalk.magenta(
          "🎲 Random aspect ratio is enabled - each image will have a different aspect ratio",
        ),
      );
    }

    const confirm = await this.promptUser(
      "\n🚀 Start generating images? (y/N): ",
    );

    if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
      console.log(chalk.yellow("Generation cancelled."));
      await this.promptUser("⏎ Press Enter to continue...");
      return;
    }

    console.log(
      chalk.blue(
        `\n🎨 Starting generation with ${this.config.workers} worker(s) for ${currentPrompts.length} prompts...\n`,
      ),
    );

    const startTime = Date.now();

    // Split prompts among workers
    const promptsPerWorker = [];
    for (let i = 0; i < this.config.workers; i++) {
      promptsPerWorker[i] = [];
    }

    // Distribute prompts round-robin style
    currentPrompts.forEach((prompt, index) => {
      const workerIndex = index % this.config.workers;
      promptsPerWorker[workerIndex].push(prompt);
    });

    // Show worker distribution
    console.log(chalk.cyan("👥 Worker Distribution:"));
    promptsPerWorker.forEach((prompts, workerId) => {
      if (prompts.length > 0) {
        console.log(`   Worker ${workerId + 1}: ${prompts.length} prompts`);
      }
    });
    console.log(
      chalk.blue(
        `\n🚀 Starting ${this.config.workers} worker(s) with ${this.config.tokens.length} token(s)...\n`,
      ),
    );

    // Start workers
    const workerPromises = promptsPerWorker.map((prompts, workerId) => {
      if (prompts.length === 0)
        return Promise.resolve({
          success: 0,
          failed: 0,
          images: [],
          completedPrompts: [],
        });
      return this.generateImagesWorker(prompts, workerId, this.config.workers);
    });

    try {
      const results = await Promise.all(workerPromises);

      // Aggregate results
      const totalSuccess = results.reduce(
        (sum, result) => sum + result.success,
        0,
      );
      const totalFailed = results.reduce(
        (sum, result) => sum + result.failed,
        0,
      );
      const allImages = results.flatMap((result) => result.images);
      const allCompletedPrompts = results.flatMap(
        (result) => result.completedPrompts,
      );
      const allFailedPrompts = results.flatMap(
        (result) => result.failedPrompts,
      );

      const endTime = Date.now();
      const duration = Math.round((endTime - startTime) / 1000);
      const minutes = Math.floor(duration / 60);
      const seconds = duration % 60;
      const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

      // Prompts are already removed individually after successful generation

      // Final results
      console.log(chalk.green.bold(`\n✅ Generation Complete!`));
      console.log(chalk.gray("━".repeat(50)));
      console.log(
        chalk.green(
          `✓ Successfully generated: ${chalk.green.bold(totalSuccess)} images`,
        ),
      );

      if (totalFailed > 0) {
        console.log(
          chalk.red(`❌ Failed prompts: ${chalk.red.bold(totalFailed)}`),
        );
      }

      console.log(chalk.blue(`⏱️  Total time: ${chalk.cyan.bold(timeStr)}`));
      console.log(
        chalk.blue(`📁 Images saved to: ${chalk.cyan(this.config.outputDir)}`),
      );

      // Calculate remaining prompts based on the current file
      let remainingPrompts = 0;
      try {
        const remainingPromptsList = await this.loadPromptsFromFile(
          this.config.promptFile,
        );
        remainingPrompts = remainingPromptsList.length;
      } catch (error) {
        console.log(
          chalk.yellow(
            `⚠️  Warning: Could not count remaining prompts: ${error.message}`,
          ),
        );
      }
      if (remainingPrompts > 0) {
        console.log(chalk.yellow(`📝 Remaining prompts: ${remainingPrompts}`));
        console.log(
          chalk.blue("💡 Run generation again to process remaining prompts"),
        );
      } else {
        console.log(chalk.green("🎉 All prompts completed!"));
      }

      console.log(
        chalk.gray(
          `🔧 Used ${this.config.workers} worker(s) with ${this.config.tokens.length} token(s)`,
        ),
      );

      if (totalSuccess > 0) {
        const avgTimePerImage = Math.round((duration / totalSuccess) * 10) / 10;
        console.log(chalk.gray(`📊 Average: ${avgTimePerImage}s per image`));
      }
    } catch (error) {
      console.log(chalk.red(`❌ Generation error: ${error.message}`));
    }

    await this.promptUser("\n⏎ Press Enter to continue...");
  }

  async run() {
    // Auto-load settings at startup
    await this.autoLoadSettings();

    console.log(chalk.blue.bold("\n🎨 Welcome to Whisk AI Image Generator!"));
    console.log(
      chalk.yellow(
        "💡 First time? Set up your API tokens and prompt file to get started.\n",
      ),
    );

    await this.promptUser("⏎ Press Enter to continue...");

    while (true) {
      const choice = await this.showMainMenu();

      switch (choice) {
        case "1":
          await this.handleTokenManagement();
          break;
        case "2":
          await this.handleSettingsConfiguration();
          break;
        case "3":
          await this.setPromptFile();
          break;
        case "4":
          await this.generateImages();
          break;
        case "5":
          await this.viewStatus();
          break;
        case "6":
          console.log(
            chalk.blue("👋 Thank you for using Whisk AI Image Generator!"),
          );
          console.log(chalk.gray("Settings have been automatically saved."));
          process.exit(0);
        default:
          console.log(chalk.red("❌ Invalid option. Please select 1-6."));
          await this.promptUser("⏎ Press Enter to continue...");
      }
    }
  }
}

// Create and run the app
const app = new WhiskTerminalApp();
app.run().catch((error) => {
  console.error(chalk.red("❌ Application error:"), error.message);
  console.error(chalk.gray("Stack trace:"), error.stack);
  process.exit(1);
});
