#!/usr/bin/env node

import fetch from "node-fetch";
import fs from "fs/promises";
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
      return { Err: new Error("Invalid prompt. Please provide a valid prompt") };
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
      "clientContext": {
        "workflowId": prompt.projectId,
        "tool": "BACKBONE",
        "sessionId": `;${Date.now()}`
      },
      "imageModelSettings": {
        "imageModel": prompt.imageModel,
        "aspectRatio": prompt.aspectRatio,
      },
      "seed": prompt.seed,
      "prompt": prompt.prompt,
      "mediaCategory": "MEDIA_CATEGORY_BOARD"
    };

    const req = {
      method: "POST",
      body: JSON.stringify(reqJson),
      url: "https://aisandbox-pa.googleapis.com/v1/whisk:generateImage",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${String(this.credentials.authorizationKey)}`,
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
      body: req.body
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
    this.config = {
      token: null,
      outputDir: './generated-images',
      aspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
      aspectRatioDisplay: 'landscape (16:9)',
      compression: 80,
      workers: 1,
      prompts: [],
      promptFile: null
    };
    this.client = null;
  }

  async ensureOutputDir() {
    try {
      await fs.access(this.config.outputDir);
    } catch {
      await fs.mkdir(this.config.outputDir, { recursive: true });
    }
  }

  async loadPromptsFromFile(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const prompts = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
      
      this.config.promptFile = filePath;
      console.log(chalk.green(`✓ Loaded ${prompts.length} prompts from ${filePath}`));
      return prompts;
    } catch (error) {
      throw new Error(`Failed to load prompts file: ${error.message}`);
    }
  }

  async compressImage(inputBuffer, quality) {
    try {
      return await sharp(inputBuffer)
        .jpeg({ quality })
        .toBuffer();
    } catch (error) {
      console.log(chalk.yellow(`Warning: Could not compress image: ${error.message}`));
      return inputBuffer;
    }
  }

  async saveImage(imageData, fileName, compress = false) {
    try {
      await this.ensureOutputDir();
      
      const buffer = Buffer.from(imageData, 'base64');
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
      'landscape-16:9': {
        code: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
        display: 'landscape (16:9)',
        description: 'Standard widescreen landscape'
      },
      'landscape-4:3': {
        code: 'IMAGE_ASPECT_RATIO_WIDE',
        display: 'landscape (4:3)',
        description: 'Traditional landscape'
      },
      'portrait-9:16': {
        code: 'IMAGE_ASPECT_RATIO_PORTRAIT',
        display: 'portrait (9:16)',
        description: 'Tall portrait format'
      },
      'portrait-3:4': {
        code: 'IMAGE_ASPECT_RATIO_TALL',
        display: 'portrait (3:4)',
        description: 'Traditional portrait'
      },
      'square-1:1': {
        code: 'IMAGE_ASPECT_RATIO_SQUARE',
        display: 'square (1:1)',
        description: 'Perfect square format'
      }
    };
  }

    async promptUser(question) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise(resolve => {
      rl.question(question, answer => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  displaySettings() {
    console.log(chalk.blue.bold('\n📋 Current Settings:'));
    console.log(chalk.gray('━'.repeat(50)));
    
    // API Key (masked for security)
    const maskedToken = this.config.token 
      ? `${this.config.token.substring(0, 10)}${'*'.repeat(this.config.token.length - 20)}${this.config.token.substring(this.config.token.length - 10)}`
      : 'Not set';
    console.log(`${chalk.cyan('API Token:')} ${maskedToken}`);
    
    // Output folder
    console.log(`${chalk.cyan('Output Folder:')} ${this.config.outputDir}`);
    
    // Input prompt file
    const promptSource = this.config.promptFile 
      ? `${this.config.promptFile} (${this.config.prompts.length} prompts)`
      : this.config.prompts.length > 0 
        ? `Manual input (${this.config.prompts.length} prompts)`
        : 'Not set';
    console.log(`${chalk.cyan('Prompt Source:')} ${promptSource}`);
    
    // Aspect ratio
    console.log(`${chalk.cyan('Aspect Ratio:')} ${this.config.aspectRatioDisplay}`);
    
    // Compression
    console.log(`${chalk.cyan('Compression:')} ${this.config.compression}%`);
    
    // Workers
    console.log(`${chalk.cyan('Workers:')} ${this.config.workers} (concurrent generations)`);
    
    console.log(chalk.gray('━'.repeat(50)));
  }

  async interactiveMode() {
    console.log(chalk.blue.bold('\n🎨 Whisk AI Image Generator\n'));

    // Get token
    if (!this.config.token) {
      this.config.token = await this.promptUser('Enter your Whisk API token: ');
      if (!this.config.token) {
        console.log(chalk.red('❌ Token is required'));
        return;
      }
    }

    this.client = new WhiskClient(this.config.token);

    // Get output directory
    const outputDir = await this.promptUser(`Output directory (${this.config.outputDir}): `);
    if (outputDir) this.config.outputDir = outputDir;

    // Get aspect ratio
    const aspectOptions = this.getAspectRatioOptions();
    console.log('\nAvailable aspect ratios:');
    Object.entries(aspectOptions).forEach(([key, value], i) => {
      console.log(`  ${i + 1}. ${value.display} - ${value.description}`);
    });
    
    const aspectChoice = await this.promptUser('Choose aspect ratio (1-5, default: landscape 16:9): ');
    const aspectKeys = Object.keys(aspectOptions);
    const aspectIndex = parseInt(aspectChoice) - 1;
    if (aspectIndex >= 0 && aspectIndex < aspectKeys.length) {
      const selectedKey = aspectKeys[aspectIndex];
      this.config.aspectRatio = aspectOptions[selectedKey].code;
      this.config.aspectRatioDisplay = aspectOptions[selectedKey].display;
    } else {
      this.config.aspectRatioDisplay = 'landscape (16:9)';
    }

    // Get compression
    const compression = await this.promptUser('Compression quality 1-100% (80): ');
    if (compression && !isNaN(compression)) {
      this.config.compression = Math.max(1, Math.min(100, parseInt(compression)));
    }

    // Get workers
    const workers = await this.promptUser('Number of workers 1-10 (1): ');
    if (workers && !isNaN(workers)) {
      this.config.workers = Math.max(1, Math.min(10, parseInt(workers)));
    }

    // Get prompts
    const promptFile = await this.promptUser('Prompts file path (leave empty for manual input): ');
    
    if (promptFile) {
      try {
        this.config.prompts = await this.loadPromptsFromFile(promptFile);
      } catch (error) {
        console.log(chalk.red(`❌ ${error.message}`));
        return;
      }
    } else {
      console.log('\nEnter prompts (empty line to finish):');
      let prompt;
      while ((prompt = await this.promptUser('Prompt: ')) !== '') {
        this.config.prompts.push(prompt);
      }
    }

    if (this.config.prompts.length === 0) {
      console.log(chalk.red('❌ No prompts provided'));
      return;
    }

    // Display settings before generation
    this.displaySettings();
    
    // Confirm before starting
    const confirm = await this.promptUser('\nProceed with image generation? (y/N): ');
    if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
      console.log(chalk.yellow('Generation cancelled.'));
      return;
    }

    // Display settings before generation
    this.displaySettings();

    await this.generateImages();
  }

  async generateImagesWorker(prompts, workerId, totalWorkers) {
    const results = { success: 0, failed: 0, images: [] };
    
    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      const globalIndex = workerId + (i * totalWorkers) + 1;
      const spinner = ora(`Worker ${workerId + 1}: Generating image ${globalIndex}: "${prompt.substring(0, 40)}..."`).start();

      try {
        const result = await this.client.generateImage({
          prompt: prompt,
          aspectRatio: this.config.aspectRatio,
          seed: Math.floor(Math.random() * 1000000)
        });

        if (result.Err) {
          spinner.fail(`Worker ${workerId + 1}: Failed - ${result.Err.message}`);
          results.failed++;
          continue;
        }

        const imagePanel = result.Ok?.imagePanels;
        if (!imagePanel || imagePanel.length === 0) {
          spinner.fail(`Worker ${workerId + 1}: No images generated`);
          results.failed++;
          continue;
        }

        let savedCount = 0;
        for (const panel of imagePanel) {
          for (const image of panel.generatedImages || []) {
            const fileName = `worker${workerId + 1}_${Date.now()}_${savedCount + 1}.jpg`;
            const filePath = await this.saveImage(image.encodedImage, fileName, this.config.compression < 100);
            results.images.push(filePath);
            savedCount++;
          }
        }

        spinner.succeed(`Worker ${workerId + 1}: Generated ${savedCount} image(s)`);
        results.success += savedCount;

      } catch (error) {
        spinner.fail(`Worker ${workerId + 1}: Error - ${error.message}`);
        results.failed++;
      }

      // Add delay between requests for same worker
      if (i < prompts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return results;
  }
  async generateImages() {
    console.log(chalk.blue(`\n🚀 Starting generation with ${this.config.workers} worker(s) for ${this.config.prompts.length} prompts...\n`));

    // Split prompts among workers
    const promptsPerWorker = [];
    for (let i = 0; i < this.config.workers; i++) {
      promptsPerWorker[i] = [];
    }

    // Distribute prompts round-robin style
    this.config.prompts.forEach((prompt, index) => {
      const workerIndex = index % this.config.workers;
      promptsPerWorker[workerIndex].push(prompt);
    });

    // Start workers
    const workerPromises = promptsPerWorker.map((prompts, workerId) => {
      if (prompts.length === 0) return Promise.resolve({ success: 0, failed: 0, images: [] });
      return this.generateImagesWorker(prompts, workerId, this.config.workers);
    });

    try {
      const results = await Promise.all(workerPromises);
      
      // Aggregate results
      const totalSuccess = results.reduce((sum, result) => sum + result.success, 0);
      const totalFailed = results.reduce((sum, result) => sum + result.failed, 0);
      const allImages = results.flatMap(result => result.images);

      console.log(chalk.green.bold(`\n✅ Generation complete!`));
      console.log(chalk.green(`✓ Successfully generated: ${totalSuccess} images`));
      if (totalFailed > 0) {
        console.log(chalk.red(`❌ Failed: ${totalFailed} prompts`));
      }
      console.log(chalk.blue(`📁 Images saved to: ${this.config.outputDir}`));
      console.log(chalk.gray(`🔧 Used ${this.config.workers} worker(s) for parallel processing`));

    } catch (error) {
      console.log(chalk.red(`❌ Worker error: ${error.message}`));
    }
  }

  async run() {
    program
      .name('whisk-generator')
      .description('Generate images using Whisk API')
      .version('1.0.0')
      .option('-t, --token <token>', 'Whisk API token')
      .option('-o, --output <dir>', 'Output directory', './generated-images')
      .option('-f, --file <path>', 'File containing prompts (one per line)')
      .option('-p, --prompt <text>', 'Single prompt to generate')
      .option('-a, --aspect <ratio>', 'Aspect ratio (landscape-16:9/landscape-4:3/portrait-9:16/portrait-3:4/square-1:1)', 'landscape-16:9')
      .option('-c, --compression <percent>', 'Compression quality 1-100', '80')
      .option('-w, --workers <count>', 'Number of workers 1-10', '1')
      .option('-i, --interactive', 'Run in interactive mode');

    program.parse();
    const options = program.opts();

    if (options.interactive) {
      return this.interactiveMode();
    }

    // Command line mode
    if (!options.token) {
      console.log(chalk.red('❌ Token is required. Use -t <token> or --interactive mode'));
      return;
    }

    this.config.token = options.token;
    this.config.outputDir = options.output;
    this.config.compression = Math.max(1, Math.min(100, parseInt(options.compression)));
    this.config.workers = Math.max(1, Math.min(10, parseInt(options.workers)));
    
    const aspectOptions = this.getAspectRatioOptions();
    const aspectOption = aspectOptions[options.aspect];
    if (aspectOption) {
      this.config.aspectRatio = aspectOption.code;
      this.config.aspectRatioDisplay = aspectOption.display;
    } else {
      console.log(chalk.yellow(`⚠️  Unknown aspect ratio '${options.aspect}', using default landscape 16:9`));
      this.config.aspectRatio = aspectOptions['landscape-16:9'].code;
      this.config.aspectRatioDisplay = aspectOptions['landscape-16:9'].display;
    }

    this.client = new WhiskClient(this.config.token);

    // Load prompts
    if (options.file) {
      try {
        this.config.prompts = await this.loadPromptsFromFile(options.file);
      } catch (error) {
        console.log(chalk.red(`❌ ${error.message}`));
        return;
      }
    } else if (options.prompt) {
      this.config.prompts = [options.prompt];
    } else {
      console.log(chalk.red('❌ Please provide prompts using -f <file> or -p <prompt>'));
      return;
    }

    await this.generateImages();
  }
}

// Create and run the app
const app = new WhiskTerminalApp();
app.run().catch(error => {
  console.error(chalk.red('❌ Application error:'), error.message);
  process.exit(1);
});

