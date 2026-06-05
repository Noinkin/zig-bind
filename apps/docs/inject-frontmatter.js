import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(__dirname, 'src/content/docs/api');
const sidebarOutputFile = path.resolve(__dirname, 'src/api-sidebar.json');

if (!fs.existsSync(apiDir)) {
  console.log('❌ API directory not found, skipping optimization.');
  process.exit(0);
}

const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1);

const rawApiFiles = fs.readdirSync(apiDir).filter(f => f.endsWith('.md') && f !== 'index.md');
const fileToUrlMap = new Map();

// --- FIRST PASS: Map true casing and establish correct target nested routes ---
for (const file of rawApiFiles) {
  const fullPath = path.join(apiDir, file);
  const content = fs.readFileSync(fullPath, 'utf8');
  
  const baseName = file.replace('.md', ''); 
  const parts = baseName.split('.');
  
  // 🎯 FIX 1: Support any heading depth (# or ##) to extract cased titles from markdown text
  const titleMatch = content.match(/^#+\s+(.+)$/m);
  let title = titleMatch ? titleMatch[1].replace(/`/g, '').trim() : parts[parts.length - 1];
  
  let cleanTitle = title.replace(/\s+(class|interface)$/i, '');

  // 🎯 FIX 2: Lowercase all file/folder tokens to match Astro's internal lowercased slug engine
  const pathParts = parts.map(part => {
    if (part === '_constructor_') return 'constructor'
    return part.toLowerCase()
});

  const relativeAstroUrl = `/zig-bind/api/${pathParts.join('/')}/`;
  
  fileToUrlMap.set(baseName, { 
    oldFullPath: fullPath, 
    parts, 
    title, 
    cleanTitle, 
    pathParts, 
    relativeAstroUrl 
  });
}

// --- SECOND PASS: Clean the text links and migrate to deep folders ---
const packagesMap = new Map();
const filesToWrite = [];

for (const [baseName, meta] of fileToUrlMap.entries()) {
  let content = fs.readFileSync(meta.oldFullPath, 'utf8');

  if (content.startsWith('---')) {
    const closingIndex = content.indexOf('---', 3);
    if (closingIndex !== -1) content = content.slice(closingIndex + 3).trim();
  }

  // 🎯 THE TARGETED LINK SWEEPER WITH INDEX FIX:
  content = content.replace(/\]\((?:\.\/)?([^)]+)\.md\)/g, (match, capturedFilename) => {
    const cleanKey = decodeURIComponent(capturedFilename);
    
    // Catch home layout index references accurately and give it the base path
    if (cleanKey === 'index') {
      return '](/zig-bind/api/)';
    }
    
    if (fileToUrlMap.has(cleanKey)) {
      return `](${fileToUrlMap.get(cleanKey).relativeAstroUrl})`;
    }
    return match;
  });

  const isPackageRoot = meta.parts.length === 1;
  const isClassOrInterface = meta.parts.length === 2;
  const isMemberMethod = meta.parts.length > 2;

  // 🎯 FIX 3: Inject true capitalization explicitly into Frontmatter properties
  let frontmatter = '---\n';
  frontmatter += `title: "${meta.title.replace(/"/g, '\\"')}"\n`; // Sets H1 to "MutationBuilder class"
  frontmatter += 'sidebar:\n';
  if (isMemberMethod) {
    frontmatter += '  hidden: true\n';
  } else if (isPackageRoot) {
    frontmatter += `  label: "${capitalize(meta.parts[0])} Package"\n`;
  } else {
    frontmatter += `  label: "${meta.cleanTitle.replace(/"/g, '\\"')}"\n`; // Explicitly forces Sidebar to "MutationBuilder"
  }
  frontmatter += '---\n\n';

  const targetFolder = path.join(apiDir, ...meta.pathParts.slice(0, -1));
  const targetFileName = `${meta.pathParts[meta.pathParts.length - 1]}.md`;
  const newFullPath = path.join(targetFolder, targetFileName);

  filesToWrite.push({ 
    targetFolder, 
    newFullPath, 
    oldFullPath: meta.oldFullPath, 
    finalContent: frontmatter + content 
  });

  if (!isMemberMethod) {
    const rawPackageName = meta.parts[0];
    const packageKey = rawPackageName.toLowerCase();

    if (!packagesMap.has(packageKey)) {
      packagesMap.set(packageKey, {
        label: rawPackageName.toUpperCase(),
        items: []
      });
    }

    const astroSlug = `api/${meta.pathParts.join('/')}`;

    if (isPackageRoot) {
      packagesMap.get(packageKey).items.unshift({
        label: `${capitalize(rawPackageName)} Package`,
        slug: astroSlug
      });
    } else if (isClassOrInterface) {
      packagesMap.get(packageKey).items.push({
        label: meta.cleanTitle, 
        slug: astroSlug
      });
    }
  }
}

// --- THIRD PASS: Write changes to disk ---
for (const file of filesToWrite) {
  fs.mkdirSync(file.targetFolder, { recursive: true });
  fs.writeFileSync(file.newFullPath, file.finalContent, 'utf8');
  
  if (file.oldFullPath !== file.newFullPath && fs.existsSync(file.oldFullPath)) {
    fs.unlinkSync(file.oldFullPath);
  }
}

// Format root index file and clean its inner cross-links if any exist
const indexFile = path.join(apiDir, 'index.md');
if (fs.existsSync(indexFile)) {
  let indexContent = fs.readFileSync(indexFile, 'utf8');
  
  indexContent = indexContent.replace(/\]\((?:\.\/)?([^)]+)\.md\)/g, (match, capturedFilename) => {
    const cleanKey = decodeURIComponent(capturedFilename);
    
    // Catch home layout index references on the overview page itself
    if (cleanKey === 'index') {
      return '](/zig-bind/api/)';
    }
    
    if (fileToUrlMap.has(cleanKey)) {
      return `](${fileToUrlMap.get(cleanKey).relativeAstroUrl})`;
    }
    return match;
  });

  if (!indexContent.startsWith('---')) {
    fs.writeFileSync(indexFile, `---\ntitle: "API Reference Overview"\n---\n\n${indexContent}`, 'utf8');
  } else {
    fs.writeFileSync(indexFile, indexContent, 'utf8');
  }
}

const structuredSidebar = Array.from(packagesMap.values());
fs.writeFileSync(sidebarOutputFile, JSON.stringify(structuredSidebar, null, 2), 'utf8');
console.log('✅ Base paths fully applied to home links!');