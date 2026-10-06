import {createRoot,type Root} from 'react-dom/client';
let root:Root|undefined;
export function startupRoot(){
 if(!root){let element=document.getElementById('root');if(!element){element=document.createElement('div');element.id='root';document.body.append(element);}root=createRoot(element);}
 return root;
}
