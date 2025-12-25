import { Container, type Newable } from 'inversify';

export class DependencyContainer {
  private readonly dep = new Container();

  public add<T>(identifier: symbol, type: Newable<T>) {
    this.dep.bind<T>(identifier).to(type).inSingletonScope();
  }

  public addDynamic<T>(identifier: symbol, factory: () => T) {
    this.dep.bind<T>(identifier).toDynamicValue(factory).inSingletonScope();
  }

  public get<T>(identifier: symbol): T {
    return this.dep.get<T>(identifier);
  }
}
