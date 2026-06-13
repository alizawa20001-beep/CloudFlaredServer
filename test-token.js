const TOKEN = "cfut_f3iz4LcdokmVuyZMwru7tgzfuZwRJOWmQIloVCOg532d78cd";
const ACCOUNT_ID = "87a058e1b6de51a50099e1e4467ff611";

async function fetchPermissionGroups() {
    console.log("\n📡 Fetching real permission groups from Cloudflare...");
    
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens/permission_groups`, {
        headers: { "Authorization": `Bearer ${TOKEN}` }
    });
    
    const data = await res.json();
    
    if (!data.success) {
        console.error("❌ Failed to fetch permission groups");
        console.error("Error:", data.errors);
        throw new Error("Cannot fetch permission groups");
    }
    
    return data.result;
}

async function createWorkerTokenWithPermissions(permissionNames) {
    console.log("\n" + "=".repeat(60));
    console.log("🚀 CREATING TOKEN WITH REAL PERMISSIONS");
    console.log("=".repeat(60));
    
    const allPermissions = await fetchPermissionGroups();
    
    const selectedPermissions = [];
    const missingPermissions = [];
    
    for (const wantedName of permissionNames) {
        const found = allPermissions.find(p => p.name === wantedName);
        if (found) {
            selectedPermissions.push({ id: found.id, name: found.name });
            console.log(`   ✅ Found: ${found.name}`);
        } else {
            missingPermissions.push(wantedName);
            console.log(`   ❌ Not found: ${wantedName}`);
        }
    }
    
    if (missingPermissions.length > 0) {
        console.log("\n⚠️ These permissions were not found. Continuing with available ones...");
    }
    
    if (selectedPermissions.length === 0) {
        throw new Error("No valid permissions found to create token");
    }
    
    const tokenName = `full-worker-token-${Date.now()}`;
    
    console.log(`\n📝 Creating token: ${tokenName}`);
    console.log(`📋 With ${selectedPermissions.length} permissions\n`);
    
    const createRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            name: tokenName,
            policies: [
                {
                    effect: "allow",
                    permission_groups: selectedPermissions,
                    resources: {
                        [`com.cloudflare.api.account.${ACCOUNT_ID}`]: "*"
                    }
                }
            ]
        })
    });
    
    const createData = await createRes.json();
    
    if (createData.success) {
        console.log("\n✅ TOKEN CREATED SUCCESSFULLY!");
        console.log("=".repeat(60));
        console.log(`🔑 TOKEN VALUE: ${createData.result.value}`);
        console.log(`🆔 Token ID: ${createData.result.id}`);
        console.log(`📝 Token Name: ${createData.result.name}`);
        console.log("=".repeat(60));
        console.log("\n⚠️ SAVE THIS TOKEN NOW - It won't be shown again!");
        
        return {
            success: true,
            tokenValue: createData.result.value,
            tokenId: createData.result.id,
            permissions: selectedPermissions.map(p => p.name)
        };
    } else {
        console.error("\n❌ Failed to create token:");
        console.error(createData.errors);
        return { success: false, error: createData.errors };
    }
}

async function listAvailablePermissions() {
    console.log("\n" + "=".repeat(60));
    console.log("📋 AVAILABLE PERMISSION GROUPS");
    console.log("=".repeat(60));
    
    const permissions = await fetchPermissionGroups();
    
    const categories = {
        "Workers Scripts": [],
        "Workers Routes": [],
        "Workers KV": [],
        "Workers R2": [],
        "D1": [],
        "Workers AI": [],
        "Other Workers": []
    };
    
    permissions.forEach(p => {
        if (p.name.includes("Workers Scripts")) categories["Workers Scripts"].push(p.name);
        else if (p.name.includes("Workers Routes")) categories["Workers Routes"].push(p.name);
        else if (p.name.includes("KV")) categories["Workers KV"].push(p.name);
        else if (p.name.includes("R2")) categories["Workers R2"].push(p.name);
        else if (p.name.includes("D1")) categories["D1"].push(p.name);
        else if (p.name.includes("Workers AI")) categories["Workers AI"].push(p.name);
        else if (p.name.includes("Workers") && !p.name.includes("Scripts")) categories["Other Workers"].push(p.name);
    });
    
    for (const [category, perms] of Object.entries(categories)) {
        if (perms.length > 0) {
            console.log(`\n📁 ${category}:`);
            perms.forEach(p => console.log(`   - ${p}`));
        }
    }
    
    return permissions;
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || "create";
    
    if (command === "list") {
        await listAvailablePermissions();
        return;
    }
    
    if (command === "create") {
        const wantedPermissions = [
            "Workers Scripts Write",
            "Workers Scripts Read",
            "Workers Routes Write",
            "Workers Routes Read",
            "Workers KV Storage Write",
            "Workers KV Storage Read",
            "Workers R2 Storage Write",
            "Workers R2 Storage Read",
            "D1 Write",
            "D1 Read",
            "Workers AI Write",
            "Workers AI Read",
            "Account Settings Read"
        ];
        
        const result = await createWorkerTokenWithPermissions(wantedPermissions);
        
        if (result.success) {
            console.log("\n✅ Token created with these permissions:");
            result.permissions.forEach(p => console.log(`   - ${p}`));
        }
        return;
    }
    
    console.log(`
╔════════════════════════════════════════════════════════════╗
║  Cloudflare Token Creator                                  ║
╠════════════════════════════════════════════════════════════╣
║  Commands:                                                 ║
║    node test-token.js list     - Show all permissions      ║
║    node test-token.js create   - Create full worker token  ║
╚════════════════════════════════════════════════════════════╝
    `);
}

main().catch(console.error);
