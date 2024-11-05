import { unified, Processor } from "unified";
import retextEnglish from "retext-english";
import { Root, Content, Literal, Parent, Sentence } from "nlcst";
import { modifyChildren } from "unist-util-modify-children";
import { visit } from "unist-util-visit";
import { toString } from "nlcst-to-string";
import{imgnum} from "../plugin";
import { Phrase, Word } from "@/db/interface";
import Plugin from "@/plugin";

const STATUS_MAP = ["ignore", "learning", "familiar", "known", "learned"];
type AnyNode = Root | Content | Content[];
export var state = 0;
export class TextParser {
    // 记录短语位置
    phrases: Phrase[] = [];
    // 记录单词状态
    words: Map<string, Word> = new Map<string, Word>();
    pIdx: number = 0;
    plugin: Plugin;
    processor: Processor;
    constructor(plugin: Plugin) {
        this.plugin = plugin;
        this.processor = unified()
            .use(retextEnglish)
            .use(this.addPhrases())
            .use(this.stringfy2HTML());
    }

    async parse(data: string) {
        let newHTML = await this.text2HTML(data.trim());
        let html = await this.processContent(newHTML)
        return html;
    }
    async processContent(htmlContent:string){
        //使用正则表达式匹配同时包含特定符号的 <p> 标签元素，并去除所有标签保留文本
        htmlContent = htmlContent.replace(/<p>(?=.*!)(?=.*\[)(?=.*\])(?=.*\()(?=.*\)).*<\/p>/g, function(match) {
            var pattern = /!\[(.*?)\]\((.*?)\)/;
            var str = match.replace(/<[^>]+>/g, '');
            var tq = pattern.exec(str);
            var img = document.createElement('img');
            var imgContainer = document.createElement('div');
            imgContainer.style.textAlign = 'center';  // 设置文本居中对齐
            var imgWrapper = document.createElement('div');
            imgWrapper.style.textAlign = 'center';  // 设置为内联块元素，使其水平居中
            if (tq) {
                var altText = tq[1];
                var srcUrl = tq[2];
                
                if (/^https?:\/\//.test(srcUrl)) {
                    img.alt = altText;
                    img.src = srcUrl;
                    imgWrapper.appendChild(img);
                    imgContainer.appendChild(imgWrapper);
                    return imgContainer.innerHTML; 
                }
                else if(imgnum){
                    let str1 = imgnum;
                    let str2 = srcUrl;
                    //let imgnum = localStorage.getItem('imgnum') || ''
                    let prefix = str2.substring(0, 3);
                    // 在 str1 中查找 prefix 的位置
                    let index = str1.indexOf(prefix);
                
                    // 如果找到匹配的前缀
                    if (index !== -1&& index !== 0 && str1.charAt(index - 1) === '/') {
                        // 截断 str1 并与 str2 相连
                        let firstPart = str1.substring(0, index);
                        img.src = firstPart + str2;
                    } else {
                        // 如果没有找到匹配的前缀，则返回 str1 和 str2 原样相连
                        img.src = str1 + str2;
                    }
                    img.alt = altText;
                    //img.src =  this.mergeStrings(localPrefix,srcUrl);
                    imgWrapper.appendChild(img);
                    imgContainer.appendChild(imgWrapper);
                    return imgContainer.innerHTML; 
                }
            }
            
        });
        // 渲染多级标题
        htmlContent = htmlContent.replace(/(<span class="stns">)# (.*?)(<\/span>)(?=\s*<\/p>)/g, '<h1>$1$2$3</h1>');
        htmlContent = htmlContent.replace(/(<span class="stns">)## (.*?)(<\/span>)(?=\s*<\/p>)/g, '<h2>$1$2$3</h2>');
        htmlContent = htmlContent.replace(/(<span class="stns">)### (.*?)(<\/span>)(?=\s*<\/p>)/g, '<h3>$1$2$3</h3>');
        htmlContent = htmlContent.replace(/(<span class="stns">)#### (.*?)(<\/span>)(?=\s*<\/p>)/g, '<h4>$1$2$3</h4>');
        htmlContent = htmlContent.replace(/(<span class="stns">)##### (.*?)(<\/span>)(?=\s*<\/p>)/g, '<h5>$1$2$3</h5>');
        htmlContent = htmlContent.replace(/(<span class="stns">)###### (.*?)(<\/span>)(?=\s*<\/p>)/g, '<h6>$1$2$3</h6>');
        
        //渲染粗体
        htmlContent = htmlContent.replace(/(?<!\\)\*(?<!\\)\*(<span.*?>.*?<\/span>)(?<!\\)\*(?<!\\)\*/g, '<b>$1</b>');
        htmlContent = htmlContent.replace(/(?<!\\)\_(?<!\\)\_(<span.*?>.*?<\/span>)(?<!\\)\_(?<!\\)\_/g, '<b>$1</b>');
    
        //渲染斜体
        htmlContent = htmlContent.replace(/(?<!\\)\*(<span.*?>.*?<\/span>)(?<!\\)\*/g, '<i>$1</i>');
        htmlContent = htmlContent.replace(/(?<!\\)\_(<span.*?>.*?<\/span>)(?<!\\)\_/g, '<i>$1</i>');
    
    
        htmlContent = htmlContent.replace(/(?<!\\)\~(?<!\\)\~(<span.*?>.*?<\/span>)(?<!\\)\~(?<!\\)\~/g, '<del>$1</del>');
    
        // 将修改后的HTML内容重新设置回元素
        return htmlContent
    }
    
    async countWords(text: string): Promise<[number, number, number]> {
        const ast = this.processor.parse(text);
        let wordSet: Set<string> = new Set();
        visit(ast, "WordNode", (word) => {
            let text = toString(word).toLowerCase();
            if (/[0-9\u4e00-\u9fa5]/.test(text)) return;
            wordSet.add(text);
        });
        await this.plugin.checkPath();
        let stored = await this.plugin.db.getStoredWords({
            article: "",
            words: [...wordSet],
        });
        let ignore = 0;
        stored.words.forEach((word) => {
            if (word.status === 0) ignore++;
        });
        let learn = stored.words.length - ignore;
        let unknown = wordSet.size - stored.words.length;
        return [unknown, learn, ignore];
    }

    async text2HTML(text: string) {
        this.pIdx = 0;
        this.words.clear();
        await this.plugin.checkPath();
        // 查找已知短语，用于构造ast中的PhraseNode
        this.phrases = (
            await this.plugin.db.getStoredWords({
                article: text.toLowerCase(), //文章
                words: [],
            })
        ).phrases;

        const ast = this.processor.parse(text); //将文本 text 解析为抽象语法树（AST）
        // 获得文章中去重后的单词
        let wordSet: Set<string> = new Set();
        visit(ast, "WordNode", (word) => {
            wordSet.add(toString(word).toLowerCase());
        });
        // 查询这些单词的status
        let stored = await this.plugin.db.getStoredWords({
            article: "",
            words: [...wordSet],
        });

        stored.words.forEach((w) => this.words.set(w.text, w));
        let HTML = this.processor.stringify(ast) as any as string;
        return HTML;
    }

    async getWordsPhrases(text: string) {
        const ast = this.processor.parse(text);
        let words: Set<string> = new Set();
        visit(ast, "WordNode", (word) => {
            words.add(toString(word).toLowerCase());
        });
        let wordsPhrases = await this.plugin.db.getStoredWords({
            article: text.toLowerCase(),
            words: [...words],
        });

        let payload = [] as string[];
        wordsPhrases.phrases.forEach((word) => {
            if (word.status > 0) payload.push(word.text);
        });
        wordsPhrases.words.forEach((word) => {
            if (word.status > 0) payload.push(word.text);
        });
        await this.plugin.checkPath();
        let res = await this.plugin.db.getExpressionsSimple(payload);
        return res;
    }

    // Plugin：在retextEnglish基础上，把AST上一些单词包裹成短语
    addPhrases() {
        let selfThis = this;
        return function (option = {}) {
            const proto = this.Parser.prototype;
            proto.useFirst("tokenizeParagraph", selfThis.phraseModifier);
        };
    }

    phraseModifier = modifyChildren(this.wrapWord2Phrase.bind(this));

    wrapWord2Phrase(node: Content, index: number, parent: Parent) {
        if (!node.hasOwnProperty("children")) return;

        if (
            this.pIdx >= this.phrases.length ||
            node.position.end.offset <= this.phrases[this.pIdx].offset
        )
            return;

        let children = (node as Sentence).children;

        let p: number;
        while (
            (p = children.findIndex(
                (child) =>
                    child.position.start.offset ===
                    this.phrases[this.pIdx].offset
            )) !== -1
        ) {
            let q = children.findIndex(
                (child) =>
                    child.position.end.offset ===
                    this.phrases[this.pIdx].offset +
                    this.phrases[this.pIdx].text.length
            );

            if (q === -1) {
                this.pIdx++;
                return;
            }
            let phrase = children.slice(p, q + 1);
            children.splice(p, q - p + 1, {
                type: "PhraseNode",
                children: phrase,
                position: {
                    start: { ...phrase.first().position.start },
                    end: { ...phrase.last().position.end },
                },
            } as any);

            this.pIdx++;

            if (
                this.pIdx >= this.phrases.length ||
                node.position.end.offset <= this.phrases[this.pIdx].offset
            )
                return;
        }
    }

    // Compiler部分: 在AST转换为string时包裹上相应标签
    stringfy2HTML() {
        let selfThis = this;
        
        return function () {
            Object.assign(this, {
                Compiler: selfThis.compileHTML.bind(selfThis),
            });
        };
    }

    compileHTML(tree: Root): string {
        return this.toHTMLString(tree);
    }

    toHTMLString(node: AnyNode): string {
        if (node.hasOwnProperty("value")) {
            return (node as Literal).value;
        }
        if (node.hasOwnProperty("children")) {
            let n = node as Parent;
            switch (n.type) {
                case "WordNode": {
                    let text = toString(n.children);
                    let textLower = text.toLowerCase();
                    let status = this.words.has(textLower)
                        ? STATUS_MAP[this.words.get(textLower).status]
                        : "new";

                    return /[0-9\u4e00-\u9fa5]/.test(text) // 不把数字当做单词
                        ? `<span class="other">${text}</span>`
                        : `<span class="word ${status}">${text}</span>`;
                }
                case "PhraseNode": {
                    let childText = toString(n.children);
                    let text = this.toHTMLString(n.children);
                    // 获取词组的status
                    let phrase = this.phrases.find(
                        (p) => p.text === childText.toLowerCase()
                    );
                    let status = STATUS_MAP[phrase.status];

                    return `<span class="phrase ${status}">${text}</span>`;
                }
                case "SentenceNode": {
                    return `<span class="stns">${this.toHTMLString(
                        n.children
                    )}</span>`;
                }
                case "ParagraphNode": {
                    return `<p>${this.toHTMLString(n.children)}</p>`;
                }
                default: {
                    return `<div class="article">${this.toHTMLString(
                        n.children
                    )}</div>`;
                }
            }
        }
        if (Array.isArray(node)) {
            let nodes = node as Content[];
            return nodes.map((n) => this.toHTMLString(n)).join("");
        }
    }

    


}

