/**
 * 识别自身模块已初始化完成的直接函数或类导出。
 * 导入别名、工厂返回值及重新赋值的绑定仍保守延后处理。
 * 此语法分类仅作观察元数据，不能证明对恶意代码的防护。
 */
export declare function ownFunctionExports(source: string): Set<string>;
