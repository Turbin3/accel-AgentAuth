use agent_auth::*;
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use crate::{state::Mandate};

fn program_id() -> Pubkey {
    "AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if"
        .parse()
        .unwrap()
}

fn setup() -> (LiteSVM, Keypair) {
    let program_path = std::env::var("AGENT_AUTH_SO")
        .unwrap_or_else(|_| "target/deploy/agent_auth.so".to_string());
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id(), program_path)
        .unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    (svm, payer)
}

fn mandate_pda(owner: &Pubkey, agent: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MANDATE_SEED, owner.as_ref(), agent.as_ref()],
        &program_id(),
    )
}


struct MandateSetup {
    svm: LiteSVM,
    payer: Keypair,
    agent: Keypair,
    mandate: Pubkey,
}


fn setup_create_mandate(duration_days: u8) -> MandateSetup {

    let (mut svm, payer) = setup();

    let agent = Keypair::new();


    let (mandate, _bump) = mandate_pda(&payer.pubkey(), &agent.pubkey());


    let expiry_timestamp: u64 = duration_days as u64 * 86400;


    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(agent.pubkey(), true),
            AccountMeta::new(mandate, false),
            AccountMeta::new_readonly(solana_pubkey::Pubkey::default(), false), 

        ],
        data: [
            vec![0u8],
            expiry_timestamp.to_le_bytes().to_vec(),
        ]
        .concat(),
    };


    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new(&[&payer, &agent], Message::new(&[ix], Some(&payer.pubkey())), blockhash);
    let meta = svm.send_transaction(tx).expect("Create Mandate instruction failed");
    println!("Create Mandate CU: {}", meta.compute_units_consumed);

    MandateSetup {
        svm,
        payer,
        agent,
        mandate,
    }

}





fn add_permission(
    md: MandateSetup,
    target_program: Pubkey,
    spend_limit: u64,
    per_tx_limit: u64,
    discriminators: &[[u8; 8]],

    ) -> MandateSetup {

    let MandateSetup {
        mut svm,
        payer,
        agent,
        mandate,
    } = md;

    let disc_len = discriminators.len() as u8;

    let mut data = [
        vec![1u8],
        target_program.to_bytes().to_vec(),
        spend_limit.to_le_bytes().to_vec(),
        per_tx_limit.to_le_bytes().to_vec(),
        vec![disc_len],
    ]
    .concat();

    for disc in discriminators {
        data.extend_from_slice(disc);
    }

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(mandate, false),
        ],
        data,
    };


    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new(&[&payer], Message::new(&[ix], Some(&payer.pubkey())), blockhash);
    let meta = svm.send_transaction(tx).expect("Add permissions instruction failed");
    println!("Add permissions CU: {}", meta.compute_units_consumed);

    MandateSetup {
        svm,
        payer,
        agent,
        mandate,
    }

}






fn remove_permission(
    md: MandateSetup,
    target_program: Pubkey
    ) -> MandateSetup {

        let MandateSetup {
            mut svm,
            payer,
            agent,
            mandate,
        } = md;


    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(mandate, false),
        ],
        data: [
            vec![2u8],
            target_program.to_bytes().to_vec(),
        ]
        .concat(),
    };


    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new(&[&payer], Message::new(&[ix], Some(&payer.pubkey())), blockhash);
    let meta = svm.send_transaction(tx).expect("Add permissions instruction failed");
    println!("Remove permissions CU: {}", meta.compute_units_consumed);

    MandateSetup {
        svm,
        payer,
        agent,
        mandate,
    }

}



#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_mandate_success() {
        let setup = setup_create_mandate(30);

        let mut account = setup.svm.get_account(&setup.mandate).unwrap();
        
        assert_eq!(account.owner, program_id());
        assert!(account.data.len() > 0);

        let mandate = Mandate::from_bytes(&mut account.data).unwrap();

        assert_eq!(mandate.owner(), setup.payer.pubkey().as_array());
        assert_eq!(mandate.agent(), setup.agent.pubkey().as_array());

        assert!(mandate.is_active());
        assert_eq!(mandate.permissions_len(), 0);
    }

    #[test]
    fn test_add_and_remove_permission() {

        let setup = setup_create_mandate(30);
        let target_program = Pubkey::new_unique();

        let spend_limit: u64 = 1_000_000;
        let per_tx_limit: u64 = 100_000;

        let discriminators = [[1, 2, 3, 4, 5, 6, 7, 8]];

        let setup = add_permission(
            setup,
            target_program,
            spend_limit,
            per_tx_limit,
            &discriminators,
        );


        let mut account = setup.svm.get_account(&setup.mandate).unwrap();
        let mandate = Mandate::from_bytes(&mut account.data).unwrap();

        assert_eq!(mandate.permissions_len(), 1);


        let setup = remove_permission(setup, target_program);

        let mut account = setup.svm.get_account(&setup.mandate).unwrap();

        let mandate = Mandate::from_bytes(&mut account.data).unwrap();

        assert_eq!(mandate.permissions_len(), 0);
    }




    // fial tests below:

    #[test]
    fn test_create_already_init() {
        let mut setup = setup_create_mandate(30);

        let expiry_timestamp: u64 = 30 * 86400;

        let ix = Instruction {
            program_id: program_id(),

            accounts: vec![
                AccountMeta::new(setup.payer.pubkey(), true),
                AccountMeta::new(setup.agent.pubkey(), true),
                AccountMeta::new(setup.mandate, false),
                AccountMeta::new_readonly(solana_pubkey::Pubkey::default(), false), 
            ],

            data: [
                vec![0u8],
                expiry_timestamp.to_le_bytes().to_vec(),
            ]
            .concat(),
        };

        let blockhash = setup.svm.latest_blockhash();

        let tx = Transaction::new(

            &[&setup.payer, &setup.agent], 
            Message::new(&[ix], Some(&setup.payer.pubkey())), 
            blockhash
        );
        
        let res = setup.svm.send_transaction(tx);
        
        assert!(res.is_err(), "Double-initialization should be blocked by the discriminator check");
    
    }




    #[test]
    fn test_add_permission_unauthorized() {

        let mut setup = setup_create_mandate(30);

        let malicious_signer = Keypair::new();
        setup.svm.airdrop(&malicious_signer.pubkey(), 1_000_000_000).unwrap();

        let target_program = Pubkey::new_unique();
        let discriminators = [[1, 2, 3, 4, 5, 6, 7, 8]];


        let ix = Instruction {

            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(malicious_signer.pubkey(), true),
                AccountMeta::new(setup.mandate, false),
            ],

            data: [
                vec![1u8],
                target_program.to_bytes().to_vec(),
                1_000_000u64.to_le_bytes().to_vec(),
                100_000u64.to_le_bytes().to_vec(),
                vec![1u8],
                discriminators[0].to_vec(),
            ]
            .concat(),
        };


        let blockhash = setup.svm.latest_blockhash();

        let tx = Transaction::new(
            &[&malicious_signer], 
            Message::new(&[ix], Some(&malicious_signer.pubkey())), 
            blockhash
        );
        
        let res = setup.svm.send_transaction(tx);

        assert!(res.is_err(), "Adding permission with a different owner must fail");

    }





    #[test]
    fn test_add_duplicate_permission() {
        let setup = setup_create_mandate(30);

        let target_program = Pubkey::new_unique();

        let discriminators = [[1, 2, 3, 4, 5, 6, 7, 8]];

        let setup = add_permission(
            setup,
            target_program,
            1_000_000,
            100_000,
            &discriminators,
        );

        let MandateSetup { mut svm, payer, agent: _, mandate } = setup;

        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(mandate, false),
            ],
            data: [
                vec![1u8],
                target_program.to_bytes().to_vec(),
                1_000_000u64.to_le_bytes().to_vec(),
                100_000u64.to_le_bytes().to_vec(),
                vec![1u8],
                discriminators[0].to_vec(),
            ]
            .concat(),
        };

        let blockhash = svm.latest_blockhash();

        let tx = Transaction::new(&[&payer], Message::new(&[ix], Some(&payer.pubkey())), blockhash);
        
        let res = svm.send_transaction(tx);
        assert!(res.is_err(), "Duplicate target permission should return InvalidInstructionData");
    }





    #[test]
    fn test_remove_non_permission() {

        let setup = setup_create_mandate(30);
        let target_program = Pubkey::new_unique();

        let MandateSetup { mut svm, payer, agent: _, mandate } = setup;

        let ix = Instruction {

            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(mandate, false),
            ],
            data: [
                vec![2u8],
                target_program.to_bytes().to_vec(),
            ]
            .concat(),
        };

        let blockhash = svm.latest_blockhash();
        let tx = Transaction::new(&[&payer], Message::new(&[ix], Some(&payer.pubkey())), blockhash);
        
        let res = svm.send_transaction(tx);

        assert!(res.is_err(), "Attempting to remove a non-existent permission must fail");
    }


}