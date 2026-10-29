// Browser translators may wrap or replace React-managed text nodes. React can then
// receive a reference node whose parent changed between renders. Keep those DOM
// operations recoverable instead of unmounting the entire wallet.
const originalInsertBefore = Node.prototype.insertBefore;
const originalRemoveChild = Node.prototype.removeChild;
const originalAppendChild = Node.prototype.appendChild;

Node.prototype.insertBefore = function <T extends Node>(newNode: T, referenceNode: Node | null): T {
  if (referenceNode && referenceNode.parentNode !== this) {
    return originalAppendChild.call(this, newNode) as T;
  }
  return originalInsertBefore.call(this, newNode, referenceNode) as T;
};

Node.prototype.removeChild = function <T extends Node>(child: T): T {
  if (child.parentNode !== this) return child;
  return originalRemoveChild.call(this, child) as T;
};
