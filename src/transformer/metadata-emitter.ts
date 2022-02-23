import { RttiVisitor } from "./rtti-visitor-base";
import * as ts from 'typescript';
import { RttiContext } from "./rtti-context";
import { Visit } from "./common/visitor-base";
import { ClassAnalyzer } from "./common/class-analyzer";
import { ClassDetails } from "./common/class-details";
import { InterfaceAnalyzer } from "./common/interface-analyzer";
import { forwardRef } from "./forward-ref";
import { literalNode } from "./literal-node";
import { decorateFunctionExpression, directMetadataDecorator } from "./metadata-decorator";
import { MetadataEncoder } from "./metadata-encoder";
import { ExternalMetadataCollector, MetadataCollector } from "./metadata-collector";

export class MetadataEmitter extends RttiVisitor {
    static emit(sourceFile : ts.SourceFile, ctx : RttiContext): ts.SourceFile {
        return new MetadataEmitter(ctx).visitNode(sourceFile);
    }

    metadataEncoder = new MetadataEncoder(this.ctx);
    collector : MetadataCollector;
    
    /**
     * The outboard metadata collector is used for class elements which are compiled away in the 
     * resulting Javascript, for instance abstract methods. In that case the decorators on the 
     * item are discarded. So instead we collect the metadata for placement outside the class 
     * definition, which is the nearest place where it is valid to insert a call expression.
     */
    outboardCollector : MetadataCollector

    collectMetadata<T = any>(callback : () => T): { node: T, decorators: { property? : string, node : ts.Node, decorator: ts.Decorator, direct: boolean }[] } {
        let originalCollector = this.collector;
        let originalOutboardCollector = this.outboardCollector;

        let collector = new ExternalMetadataCollector();
        this.collector = this.outboardCollector = collector;

        try {
            return {
                node: callback(),
                decorators: collector.decorators
            }
        } finally {
            this.collector = originalCollector;
            this.outboardCollector = originalOutboardCollector;
        }
    }


    scope<T = any>(nameScope : ts.ClassDeclaration | ts.InterfaceDeclaration, callback: () => T) {
        let originalScope = this.ctx.currentNameScope;
        this.ctx.currentNameScope = nameScope;

        try {
            return callback();
        } finally {
            this.ctx.currentNameScope = originalScope;
        }
    }

    @Visit([ts.SyntaxKind.PropertyDeclaration, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor])
    property(decl : ts.PropertyDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration) {
        return this.collector.collect(decl, this.metadataEncoder.property(decl));
    }

    @Visit(ts.SyntaxKind.PropertySignature)
    propertySignature(signature : ts.PropertySignature) {
        if (ts.isInterfaceDeclaration(signature.parent))
            signature = this.collector.collect(signature, this.metadataEncoder.property(signature));
            
        return signature;
    }

    @Visit(ts.SyntaxKind.ClassDeclaration)
    class(decl : ts.ClassDeclaration) {
        let details = ClassAnalyzer.analyze(decl, this.context);
        let className = decl.name.getText();

        return this.scope(decl, () => {
            let outboardMetadata = this.collectMetadata(() => {
                try {
                    decl = this.collector.collect(decl, this.metadataEncoder.class(<ts.ClassDeclaration>decl, details));
                    decl = this.visitEachChild(decl);
                    return <ts.ClassDeclaration>decl;
                } catch (e) {
                    console.error(`RTTI: During outboard metadata collection for class ${className}: ${e.message}`);
                    throw e;
                }
            });

            if (this.trace) console.log(` - ${outboardMetadata.decorators.length} outboard decorators`);

            return [
                decl,
                ...(this.emitOutboardMetadata(decl as ts.ClassDeclaration, outboardMetadata))
            ]
        });
    }

    @Visit(ts.SyntaxKind.InterfaceDeclaration)
    interface(decl : ts.InterfaceDeclaration) {
        this.ctx.interfaceSymbols.push(
            {
                interfaceDecl: decl,
                symbolDecl: [
                    ts.factory.createVariableStatement(
                        [],
                        ts.factory.createVariableDeclarationList(
                            [ts.factory.createVariableDeclaration(
                                ts.factory.createIdentifier(`IΦ${decl.name.text}`),
                                undefined,
                                undefined,
                                ts.factory.createObjectLiteralExpression([
                                    ts.factory.createPropertyAssignment(
                                        'name',
                                        ts.factory.createStringLiteral(decl.name.text)
                                    ),
                                    ts.factory.createPropertyAssignment(
                                        'prototype',
                                        ts.factory.createObjectLiteralExpression()
                                    ),
                                    ts.factory.createPropertyAssignment(
                                        'identity',
                                        ts.factory.createCallExpression(
                                            ts.factory.createIdentifier("Symbol"),
                                            undefined,
                                            [ts.factory.createStringLiteral(`${decl.name.text} (interface)`)]
                                        )
                                    )
                                ])
                                
                            )],
                            ts.NodeFlags.Const
                        )
                    ),
                    ...(
                        (decl.modifiers && decl.modifiers.some(x => x.kind === ts.SyntaxKind.ExportKeyword))
                        ? [ts.factory.createExportDeclaration(
                            undefined,
                            undefined,
                            false,
                            ts.factory.createNamedExports(
                                [
                                    ts.factory.createExportSpecifier(
                                        false,
                                        undefined,
                                        ts.factory.createIdentifier(`IΦ${decl.name.text}`)
                                    )
                                ]
                            ),
                            undefined
                        )] : []
                    )
                ]
            }
        );
        
        if (this.trace)
            console.log(`Decorating interface ${decl.name.text}`);
        
        let details : ClassDetails = { 
            ...InterfaceAnalyzer.analyze(decl, this.context), 
            staticPropertyNames: [], 
            staticMethodNames: [] 
        };
        let interfaceName = decl.name.getText();
        let interfaceDecl = decl;
        
        return this.scope(decl, () => {
            let result = this.collectMetadata(() => {
                try {
                    return this.visitEachChild(decl);
                } catch (e) {
                    console.error(`RTTI: During metadata collection for interface ${interfaceName}: ${e.message}`);
                    throw e;
                }
            });

            return [
                result.node,
                ...this.metadataEncoder.class(<ts.InterfaceDeclaration>decl, details)
                    .map(decorator => ts.factory.createCallExpression(decorator.expression, undefined, [
                        ts.factory.createIdentifier(`IΦ${(decl as ts.InterfaceDeclaration).name.text}`)
                    ])),
                ...this.emitOutboardMetadata(interfaceDecl, result),
                ...(result.decorators.map(dec => ts.factory.createCallExpression(dec.decorator.expression, undefined, [
                    ts.factory.createPropertyAccessExpression(
                        ts.factory.createIdentifier(`IΦ${(decl as ts.InterfaceDeclaration).name.text}`), 
                        'prototype'
                    ),
                    ts.factory.createStringLiteral(dec.property)
                ])))
            ]
        });
    }

    @Visit(ts.SyntaxKind.FunctionDeclaration)
    functionDecl(decl : ts.FunctionDeclaration) {
        if (!decl.body)
            return;
        
        // Note that we check for node.body here ^^ in case of
        // "function a();" which will trigger an error later anyway.

        let metadata = this.metadataEncoder.method(decl);
        let functionName = decl.name.getText();

        if (!ts.isBlock(decl.parent) && !ts.isSourceFile(decl.parent)) {
            // Care must be taken here. Take this example:
            //   if (true) function foo() { return 123 }
            //   expect(foo()).to.equal(123)
            //
            // In that case, foo() is *declared*, not an expression,
            // and it should be available outside the if() statement.
            // A corner case, but one that we shouldn't break on.
            // Since a function declaration in an expression becomes a 
            // function expression, and named function expressions have 
            // their own scope, we can't just emit ie: 
            //
            //   if (true) __RΦ.f(function a() { }, [ ... ])
            //
            // ...because a() will no longer be in scope. 
            // Thankfully, since function declaration semantics match those of 
            // the var keyword, we can accomplish this with:
            //
            //    if (true) var a = __RΦ.f(function a() { }, [ ... ])

            let expr = ts.factory.createFunctionExpression(
                decl.modifiers, decl.asteriskToken, decl.name, decl.typeParameters, decl.parameters, 
                decl.type, decl.body
            );

            try {
                expr = this.visitEachChild(expr);
            } catch (e) {
                console.error(`RTTI: During non-block function declaration ${functionName}: ${e.message}`);
                throw e;
            }

            return ts.factory.createVariableStatement([], [
                ts.factory.createVariableDeclaration(
                    decl.name.getText(), undefined, undefined, 
                    decorateFunctionExpression(expr, metadata)
                )
            ]);
        }

        try {
            decl = this.visitEachChild(decl);
        } catch (e) {
            console.error(`RTTI: During function declaration ${functionName}: ${e.message}`);
            throw e;
        }

        return [
            decl,
            ...(metadata.map(dec => ts.factory.createExpressionStatement(ts.factory.createCallExpression(dec.expression, undefined, [
                ts.factory.createIdentifier(`${(decl as ts.FunctionDeclaration).name.text}`)
            ]))))
        ]
    }

    @Visit([ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction])
    functionExpr(decl : ts.FunctionExpression | ts.ArrowFunction) {
        return decorateFunctionExpression(this.visitEachChild(decl), this.metadataEncoder.method(decl));
    }

    @Visit(ts.SyntaxKind.MethodDeclaration)
    method(decl : ts.MethodDeclaration) {
        if (!ts.isClassDeclaration(decl.parent))
            return;
        if (this.trace)
            console.log(`Decorating class method ${decl.parent.name.text}#${decl.name.getText()}`);
        
        let metadata = this.metadataEncoder.method(decl);
        let name = decl.name.getText();
        let isAbstract = (decl.modifiers ?? []).some(x => x.kind === ts.SyntaxKind.AbstractKeyword);

        if (isAbstract) {
            this.outboardCollector.collect(decl, metadata);
        } else {
            // Also collect the flags and host reference on the concrete method itself for resolving
            // ReflectedMethod from a bare method function.

            this.outboardCollector.collect(decl, [ 
                directMetadataDecorator('rt:f', this.metadataEncoder.methodFlags(decl)),
                directMetadataDecorator('rt:h', literalNode(forwardRef(decl.parent.name)))
            ]);

            decl = this.collector.collect(decl, metadata);
        }

        return this.visitEachChild(decl);
    }

    @Visit(ts.SyntaxKind.MethodSignature)
    methodSignature(node : ts.MethodSignature) {
        if (!ts.isInterfaceDeclaration(node.parent))
            return;
        if (this.trace)
            console.log(`Decorating interface method ${node.parent.name.text}#${node.name.getText()}`);
        
        return this.collector.collect(node, this.metadataEncoder.method(node));
    }

    
    emitOutboardMetadata<NodeT extends ts.ClassDeclaration | ts.InterfaceDeclaration>(
        node : NodeT, 
        outboardMetadata : { node: NodeT, decorators: { property? : string, node : ts.Node, decorator: ts.Decorator, direct: boolean }[] }
    ) {
        let nodes : ts.Node[] = [];
        let elementName = node.name.text;
        for (let dec of outboardMetadata.decorators) {
            let host : ts.Expression = ts.factory.createIdentifier(elementName);

            if (ts.isInterfaceDeclaration(node)) {
                let interfaceName = `IΦ${node.name.text}`;
                host = ts.factory.createIdentifier(interfaceName);
            }

            let isStatic = false;

            if (ts.isPropertyDeclaration(dec.node) || ts.isMethodDeclaration(dec.node) || ts.isGetAccessor(dec.node) || ts.isSetAccessor(dec.node))
                isStatic = (dec.node.modifiers ?? <ts.Modifier[]>[]).some(x => x.kind === ts.SyntaxKind.StaticKeyword);
            if (ts.isClassDeclaration(dec.node))
                isStatic = true;
            
            if (!isStatic)
                host = ts.factory.createPropertyAccessExpression(host, 'prototype');
            
            if (dec.property) {
                if (dec.direct) {
                    host = ts.factory.createPropertyAccessExpression(host, dec.property);
                    nodes.push(ts.factory.createExpressionStatement(ts.factory.createCallExpression(dec.decorator.expression, undefined, [ host ])));
                } else {
                    nodes.push(ts.factory.createExpressionStatement(ts.factory.createCallExpression(dec.decorator.expression, undefined, [ 
                        host,
                        ts.factory.createStringLiteral(dec.property)
                    ])));
                }
            } else {
                nodes.push(ts.factory.createExpressionStatement(ts.factory.createCallExpression(dec.decorator.expression, undefined, [ 
                    host
                ])));
            }
        }

        return nodes;
    }
}